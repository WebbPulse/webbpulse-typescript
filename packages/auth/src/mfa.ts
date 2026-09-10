/**
 * The client half of the identity service's M4 surface: TOTP enrolment,
 * recovery codes and step-up.
 *
 * `login` and `completeTotp` already covered the two legs of an MFA sign in.
 * What was missing was everything a user does once they are already signed in:
 * turning a factor on, seeing the recovery codes it issues, replacing that set,
 * turning the factor off, and proving freshness before a sensitive action. This
 * module holds the outcome types for those five, and {@link AuthClient} holds
 * the methods.
 *
 * ## Why these return outcomes rather than throwing
 *
 * The same reason the M3 link flows do, and the reason is sharper here. Every
 * one of these routes has a refusal that is a normal thing for a user to hit
 * with a form open in front of them:
 *
 * - a wrong or replayed TOTP code, which the server answers as one refusal for
 *   every reason, `INVALID_MFA_CODE`;
 * - an enrolment started twice, `TOTP_ALREADY_ENABLED`;
 * - an activation with nothing pending, `NO_PENDING_ENROLMENT`;
 * - a rate limit, which section 5.1 sets at ten verifications per fifteen
 *   minutes and ten enrolment starts per hour per IP.
 *
 * A user mistyping a six digit code is the single most likely thing to happen
 * on an activation form. Putting that in a `catch` puts the common path in the
 * handler, so these resolve to a union discriminated on `ok` in the style of
 * {@link LoginOutcome}, and reject only for a network failure or a 500.
 *
 * ## What the server tells you, and what it refuses to
 *
 * `verify_challenge` answers with one failure for every reason: wrong code,
 * replayed code, no factor enrolled, a factor enrolled but not activated, a
 * spent recovery code and a recovery code that never existed. That is
 * deliberate, and it is why {@link MfaCodeRejected} is one case rather than
 * six. A client that split it would be inventing information it does not have.
 *
 * Four of the five routes take a code: activation, disable, recovery code
 * regeneration and step-up. Disable and regenerate ask for one because a
 * bearer token alone is a weaker thing to hold than a bearer token plus a live
 * factor, and both of those routes either remove the second factor or void the
 * printout that survives losing it. Either accepts a current TOTP code or an
 * unspent recovery code, the same pair `verify_challenge` accepts everywhere.
 *
 * The one thing that is disclosed is the rate limit, which is a signal about
 * the caller rather than about the account.
 *
 * ## Both secrets are shown exactly once
 *
 * The seed comes back from `enrolTotp` in plaintext once and there is no route
 * that reads it back: a user who loses it before activating enrols again and
 * gets a new one. The recovery codes come back from `activateTotp` once, and
 * the only way to see a set again is `regenerateRecoveryCodes`, which replaces
 * every code and invalidates the printout the user was trying to recover. A UI
 * that renders either of these without telling the user it will not be shown
 * again is setting up a support ticket.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * The factor name the server uses in a login challenge and on the enrol routes.
 *
 * Mirrors `TOTP_FACTOR` in `webbpulse.identity.mfa`. Compare against this
 * rather than a literal when reading `factors` off an
 * {@link AuthMfaRequired}, so a rename on the wire is one edit here.
 */
export const TOTP_FACTOR = 'totp';

/**
 * The fields every MFA refusal carries.
 *
 * `reason` is added by each member below rather than declared here as a union,
 * for the reason `RefusalFields` in `email-flows.ts` gives: a single interface
 * with a union-typed `reason` does not narrow under `Extract`, and each method
 * would have to cast its result back to the subset it returns.
 */
interface MfaRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  /** The server's own sentence. Render this rather than a local one. */
  message: string;
}

/**
 * A code the server would not accept.
 *
 * One case, because the server answers with one refusal for every reason it
 * could have had. See the module note on what a caller is allowed to learn.
 */
export interface MfaCodeRejected extends MfaRefusalFields {
  reason: 'invalid-code';
}

/**
 * An enrolment refused because the account already has an active factor.
 *
 * The remedy is to disable the existing factor and enrol again, which is the
 * only path the server offers: it will not silently replace a working
 * authenticator with an unconfirmed one.
 */
export interface TotpAlreadyEnabled extends MfaRefusalFields {
  reason: 'already-enabled';
}

/**
 * An activation with no pending enrolment to activate.
 *
 * Usually a stale form: the user reloaded, or activated in another tab. The
 * remedy is to start the enrolment again, which issues a new seed.
 */
export interface NoPendingEnrolment extends MfaRefusalFields {
  reason: 'no-pending-enrolment';
}

/**
 * A rate limit. Section 5.1 puts verification at ten per fifteen minutes and
 * starting an enrolment at ten per hour per IP.
 */
export interface MfaRateLimited extends MfaRefusalFields {
  reason: 'rate-limited';
  /** Seconds to wait, when the body carried a hint. Frequently `undefined`. */
  retryAfter: number | undefined;
}

/**
 * MFA is not configured on this deployment.
 *
 * The six MFA routes mount only when TOTP is enabled and both M4 tables are
 * supplied, so in practice a product either has all of them or none. This
 * models the 503 the flow layer raises when the routes exist but the service
 * behind them does not, which is a deployment fault and not a user error.
 */
export interface MfaUnavailable extends MfaRefusalFields {
  reason: 'unavailable';
}

/** A pending enrolment, with the two forms of the seed a user can use. */
export interface TotpEnrolmentStarted {
  ok: true;
  /**
   * The base32 seed, for a user who cannot scan a QR code and types it in.
   *
   * Returned in plaintext exactly once. There is no route that reads it back.
   */
  secret: string;
  /**
   * The `otpauth://totp/…` URI to render as a QR code.
   *
   * The server builds it, so the issuer and account label match what the
   * authenticator will display. Render this as a QR code with whatever
   * generator the product already has: this package adds no dependency for it.
   */
  provisioningUri: string;
}

/** What {@link AuthClient.enrolTotp} resolves to. */
export type TotpEnrolmentOutcome =
  TotpEnrolmentStarted | TotpAlreadyEnabled | MfaRateLimited | MfaUnavailable;

/** An activation that turned the factor on, with the codes it issued. */
export interface TotpActivated {
  ok: true;
  /**
   * The recovery codes, in plaintext, shown exactly once.
   *
   * Ten of them, hyphen grouped for reading off paper. The server hashes them
   * and cannot show them again; the only way to see a set is to replace it.
   */
  recoveryCodes: string[];
}

/** What {@link AuthClient.activateTotp} resolves to. */
export type TotpActivationOutcome =
  | TotpActivated
  | MfaCodeRejected
  | NoPendingEnrolment
  | MfaRateLimited
  | MfaUnavailable;

/** A factor that was removed, along with every recovery code it had. */
export interface TotpDisabled {
  ok: true;
}

/** What {@link AuthClient.disableTotp} resolves to. */
export type TotpDisableOutcome =
  TotpDisabled | MfaCodeRejected | MfaRateLimited | MfaUnavailable;

/** A fresh set of recovery codes, which invalidated the previous one. */
export interface RecoveryCodesIssued {
  ok: true;
  /** The new codes, in plaintext, shown exactly once. */
  recoveryCodes: string[];
}

/** What {@link AuthClient.regenerateRecoveryCodes} resolves to. */
export type RecoveryCodesOutcome =
  RecoveryCodesIssued | MfaCodeRejected | MfaRateLimited | MfaUnavailable;

/** A step-up that produced a fresher access token inside the same session. */
export interface StepUpSucceeded {
  ok: true;
  /**
   * Seconds until the new access token expires, as the server reported it.
   *
   * The token itself is not here. It was adopted into the client's in-memory
   * store, which is the only place an access token lives, so the next request
   * carries it without the caller doing anything.
   */
  expiresIn: number | undefined;
}

/** What {@link AuthClient.stepUp} resolves to. */
export type StepUpOutcome =
  StepUpSucceeded | MfaCodeRejected | MfaRateLimited | MfaUnavailable;

/** Where the five authorized MFA routes live, relative to the base URL. */
export interface MfaPaths {
  /** Defaults to `/api/auth/totp/enrol`. */
  totpEnrol?: string;
  /** Defaults to `/api/auth/totp/activate`. */
  totpActivate?: string;
  /** Defaults to `/api/auth/totp/disable`. */
  totpDisable?: string;
  /** Defaults to `/api/auth/recovery-codes`. */
  recoveryCodes?: string;
  /** Defaults to `/api/auth/step-up`. */
  stepUp?: string;
}

/** Every refusal any of the five MFA routes can produce. */
export type MfaRefusal =
  | MfaCodeRejected
  | TotpAlreadyEnabled
  | NoPendingEnrolment
  | MfaRateLimited
  | MfaUnavailable;

/**
 * Reads a retry hint in seconds off a 429 body, when the server sent one.
 *
 * Duplicated in spirit from `retryAfterSeconds` in `email-flows.ts`, and it
 * calls that function rather than reimplementing the parse. It exists here only
 * so this module does not import the link flows for one helper.
 */
function retryAfterOf(error: ApiError): number | undefined {
  const { details } = getWebbPulseError(error);
  if (details === undefined || Array.isArray(details)) {
    return undefined;
  }
  const value = details['retry_after'];
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : undefined;
}

/**
 * Classifies a thrown error from one of the five MFA routes, or returns null.
 *
 * `expected` is the set of reasons the calling method models, so a refusal that
 * is a legitimate outcome on one route cannot become a silent success on
 * another: `regenerateRecoveryCodes` never returns `invalid-code`, and one
 * arriving there would be a server bug worth throwing on.
 *
 * A 401 carrying `NOT_AUTHENTICATED` is deliberately **not** classified. It
 * means the bearer token was missing or dead, which is the client's own
 * business and which `@webbpulse/api-client` has already tried to repair with
 * one refresh and one replay. Turning it into an outcome would hide a session
 * that ended behind a form field error.
 */
export function classifyMfaError<
  TReason extends MfaRefusal['reason'],
  TRefusal extends MfaRefusal = Extract<MfaRefusal, { reason: TReason }>,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/**
 * The untyped body of {@link classifyMfaError}.
 *
 * Split out for the reason `classify` in `email-flows.ts` is: TypeScript cannot
 * prove a concrete `{ reason: 'rate-limited' }` satisfies an unresolved
 * `TReason`, even though the runtime `expected.has` guard is exactly that
 * proof. The cast lives here once rather than at each call site.
 */
function classify(
  error: unknown,
  expected: ReadonlySet<MfaRefusal['reason']>
): MfaRefusal | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const envelope = getWebbPulseError(error);
  const rawCode = envelope.errorCode;
  const base = {
    ok: false as const,
    code: getAuthErrorCode(error),
    message: envelope.message,
  };

  // Checked before the status branches. A 401 here is the shared MFA refusal
  // and not an expired session, and the two must not be confused: one is a
  // wrong code the user retypes, the other ends the session.
  if (rawCode === 'INVALID_MFA_CODE' && expected.has('invalid-code')) {
    return { ...base, reason: 'invalid-code' };
  }
  if (rawCode === 'TOTP_ALREADY_ENABLED' && expected.has('already-enabled')) {
    return { ...base, reason: 'already-enabled' };
  }
  if (
    rawCode === 'NO_PENDING_ENROLMENT' &&
    expected.has('no-pending-enrolment')
  ) {
    return { ...base, reason: 'no-pending-enrolment' };
  }
  if (rawCode === 'MFA_NOT_CONFIGURED' && expected.has('unavailable')) {
    return { ...base, reason: 'unavailable' };
  }
  if (error.status === 429 && expected.has('rate-limited')) {
    // The rate limit dependency raises a bare 429 with no error_code, so this
    // branches on the status rather than on a code that is not there.
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}
