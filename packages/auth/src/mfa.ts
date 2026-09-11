/**
 * The client half of the identity service's MFA surface: TOTP enrolment,
 * recovery codes, disable and step-up. The methods live on {@link AuthClient}
 * and resolve to outcomes rather than throwing, because a mistyped six digit
 * code is the likeliest thing a form sees.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * The factor name the server uses in a login challenge and on the enrol routes.
 * Compare against this rather than a literal when reading `factors` off an
 * {@link AuthMfaRequired}.
 */
export const TOTP_FACTOR = 'totp';

/**
 * The fields every MFA refusal carries. `reason` is added by each member below
 * rather than declared here as a union, so `Extract` narrows to one member.
 */
interface MfaRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  /** The server's own sentence. Render this rather than a local one. */
  message: string;
}

/**
 * A code the server would not accept. One case, because the server answers with
 * one refusal for wrong, replayed, spent and never-issued codes alike.
 */
export interface MfaCodeRejected extends MfaRefusalFields {
  reason: 'invalid-code';
}

/**
 * An enrolment refused because the account already has an active factor. The
 * remedy is to disable it and enrol again.
 */
export interface TotpAlreadyEnabled extends MfaRefusalFields {
  reason: 'already-enabled';
}

/**
 * An activation with no pending enrolment, usually a stale form. The remedy is
 * to start the enrolment again, which issues a new seed.
 */
export interface NoPendingEnrolment extends MfaRefusalFields {
  reason: 'no-pending-enrolment';
}

/** A rate limit on verification or on starting an enrolment. */
export interface MfaRateLimited extends MfaRefusalFields {
  reason: 'rate-limited';
  /** Seconds to wait, when the body carried a hint. Frequently `undefined`. */
  retryAfter: number | undefined;
}

/**
 * MFA is not configured on this deployment. A deployment fault rather than a
 * user error, which is why it is its own case.
 */
export interface MfaUnavailable extends MfaRefusalFields {
  reason: 'unavailable';
}

/** A pending enrolment, with the two forms of the seed a user can use. */
export interface TotpEnrolmentStarted {
  ok: true;
  /**
   * The base32 seed, for a user who cannot scan a QR code. Returned in
   * plaintext exactly once; no route reads it back.
   */
  secret: string;
  /**
   * The `otpauth://totp/...` URI to render as a QR code. The server builds it so
   * the issuer and account label match what the authenticator displays.
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
   * The recovery codes, in plaintext, shown exactly once. The server hashes
   * them; the only way to see a set again is to replace it.
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
   * Seconds until the new access token expires. The token itself was adopted
   * into the client's in-memory store, so the next request carries it.
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
 * Reads a retry hint in seconds off a 429 body. Delegates to the link flows'
 * parse, and exists only so this module does not import them for one helper.
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
 * Classifies a thrown error from an MFA route, or returns null. `expected` is
 * the set of reasons the calling method models, so a refusal that is an outcome
 * on one route cannot become a silent success on another.
 */
export function classifyMfaError<
  TReason extends MfaRefusal['reason'],
  TRefusal extends MfaRefusal = Extract<MfaRefusal, { reason: TReason }>,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/**
 * The untyped body of {@link classifyMfaError}. Split out because TypeScript
 * cannot prove a concrete reason object satisfies an unresolved `TReason`, so
 * the cast lives here once rather than at each call site.
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
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}
