/**
 * The two link-based identity flows: email verification and password reset.
 *
 * Section 2.6 of the identity standard calls these one primitive, "a single-use,
 * time-limited, signed link", and the backend implements them that way: one
 * token table, one purpose field, one refusal. This module is the client half,
 * and it keeps the symmetry, because the two flows differ only in which pair of
 * routes they call and which page the mailed link lands on.
 *
 * ## Why these four methods return outcomes rather than throwing
 *
 * Every other method on {@link AuthClient} either settles a session or rejects,
 * and rejecting is right for those: a failed login has no result to hand back.
 * These four are different. Three of their four failure modes are *expected*
 * answers that a form has to render inline rather than catch:
 *
 * - a link that is unknown, expired, already spent, or presented to the wrong
 *   endpoint, which the server answers as one refusal on purpose;
 * - a new password that fails the policy in 5.6;
 * - a rate limit, which section 5.1 puts on all four routes at 3 per hour per
 *   address and 10 per hour per IP.
 *
 * A `try`/`catch` around a call whose most likely non-success is "this link has
 * expired" is the wrong shape: it puts the common path in the handler. So these
 * return a discriminated union in the style of {@link LoginOutcome}, and reject
 * only for what a caller genuinely cannot have anticipated, which is a network
 * failure or a 500.
 *
 * ## Why the request side has no failure branch to speak of
 *
 * Section 5.4 puts both request endpoints in the enumeration-resistance table:
 * they answer 200 whether or not the address has an account, whether or not it
 * is already verified. There is deliberately nothing in the response to branch
 * on, so {@link EmailRequestOutcome} carries `sent: true` and the server's own
 * sentence rather than anything the caller could use to tell the two cases
 * apart. A client that inferred existence from a timing difference would be
 * defeating a control the backend spends real effort on.
 *
 * The one thing that *can* come back is a 429, and it is exposed, because a
 * form that silently swallows a rate limit shows the user a success message for
 * a mail that will never arrive.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * The SPA path a verification link lands on.
 *
 * Must equal `VERIFY_LINK_PATH` in `webbpulse.identity.verification`, which is
 * what the backend concatenates onto `frontend_base_url` when it builds the URL
 * it mails. The two constants are a contract across two repositories with
 * nothing enforcing them at build time, so both sides carry a test asserting the
 * literal.
 *
 * The mailed URL is `<frontend_base_url><VERIFY_EMAIL_PATH>?token=<token>`.
 */
export const VERIFY_EMAIL_PATH = '/verify-email';

/**
 * The SPA path a password reset link lands on.
 *
 * Must equal `RESET_LINK_PATH` in `webbpulse.identity.verification`. Note that
 * it is **not** the API route: the API confirms a reset at `/api/auth/reset/confirm`,
 * and this is the page that collects the new password and calls it.
 */
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * The query parameter the token arrives in.
 *
 * A query parameter rather than a path segment, matching `TOKEN_PARAM` on the
 * backend. A path segment is what a router logs as a route, which would put a
 * live credential in an access log.
 */
export const LINK_TOKEN_PARAM = 'token';

/**
 * A verification or reset request that the server accepted.
 *
 * There is no `sent: false`. Section 5.4 requires the request endpoints to
 * answer identically for an unknown address, an already verified one, and one
 * that just got a link, so there is no second case for this type to model. The
 * name says `sent` because that is the server's own field, and the honest
 * reading of it is "the request was accepted", which is what `detail` says in
 * words on the reset route.
 */
export interface EmailRequestSent {
  ok: true;
  /**
   * The server's message, when it sent one.
   *
   * The reset route sends section 5.4's exact sentence, "If that address has an
   * account, a link is on its way." Rendering the server's copy rather than
   * inventing a local one keeps a single wording for a sentence that is
   * carefully phrased to promise nothing.
   */
  detail: string | undefined;
}

/**
 * The fields every refusal carries, whatever its reason.
 *
 * `reason` is added by each member below rather than declared here as a union,
 * so `Extract<..., { reason: 'rate-limited' }>` narrows to exactly one member.
 * A single interface with a union-typed `reason` would not narrow, and each
 * method would have to cast its result back to the subset it actually returns,
 * which is the cast this shape exists to avoid.
 */
interface RefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  message: string;
  /**
   * Seconds to wait before retrying, when the body carried a hint.
   *
   * Frequently `undefined` even on a 429: the server puts the wait in a
   * `Retry-After` header, and `ApiError` does not keep the `Response`. See
   * {@link retryAfterSeconds}.
   */
  retryAfter: number | undefined;
}

/**
 * A rate limit. Section 5.1 puts all four routes at 3 per hour per address and
 * 10 per hour per IP, and the per-account lockout adds `TOO_MANY_ATTEMPTS`.
 */
export interface RateLimited extends RefusalFields {
  reason: 'rate-limited';
}

/**
 * An identity deployment with no sender configured.
 *
 * A deployment fault rather than a user error, which is why it is not folded
 * into the rate limit case: the user can do nothing about it and a "try again
 * in an hour" message would be a lie.
 */
export interface EmailUnavailable extends RefusalFields {
  reason: 'unavailable';
}

/** What {@link AuthClient.requestEmailVerification} resolves to. */
export type EmailRequestOutcome =
  EmailRequestSent | RateLimited | EmailUnavailable;

/** Either refusal the two request routes can produce. */
export type EmailRequestRefused = RateLimited | EmailUnavailable;

/** A verification link that was accepted and spent. */
export interface EmailVerificationConfirmed {
  ok: true;
  /** The account the link belonged to, as the server reported it. */
  userId: string | null;
}

/**
 * A link the server refused.
 *
 * One case for unknown, expired, already used and wrong purpose, because that
 * is exactly how the server answers and the distinction is deliberately not
 * disclosed: telling a caller holding a guessed value that it was "already
 * used" confirms the guess found a real token. A client that split this into
 * four states would be inventing information it does not have.
 */
export interface InvalidLink extends RefusalFields {
  reason: 'invalid-link';
}

/** Every refusal a link confirmation can produce. */
export type LinkRefused = InvalidLink | RateLimited | EmailUnavailable;

/** What {@link AuthClient.confirmEmailVerification} resolves to. */
export type EmailVerificationOutcome = EmailVerificationConfirmed | LinkRefused;

/** A reset that completed: the password is changed and every session is gone. */
export interface PasswordResetConfirmed {
  ok: true;
}

/**
 * A reset the server refused because the new password failed the policy.
 *
 * Separate from {@link LinkRefused} because the remedy is different and the
 * caller has to know which: a rejected password means "the link is spent, ask
 * for a new one and choose a different password", and the message names what
 * was wrong with the password. Section 5.6's codes are `PASSWORD_TOO_SHORT`,
 * `PASSWORD_TOO_LONG` and `WEAK_PASSWORD`.
 */
export interface PasswordResetRejected extends RefusalFields {
  reason: 'password-rejected';
}

/** What {@link AuthClient.confirmPasswordReset} resolves to. */
export type PasswordResetOutcome =
  PasswordResetConfirmed | LinkRefused | PasswordResetRejected;

/** Where the four link routes live, relative to the base URL. */
export interface EmailFlowPaths {
  /** Defaults to `/api/auth/verify-email`. */
  verifyEmail?: string;
  /** Defaults to `/api/auth/verify-email/confirm`. */
  verifyEmailConfirm?: string;
  /** Defaults to `/api/auth/reset`. */
  passwordReset?: string;
  /** Defaults to `/api/auth/reset/confirm`. */
  passwordResetConfirm?: string;
}

/**
 * Reads the link token out of a URL.
 *
 * Defaults to the current location, which is the whole point: the two landing
 * pages are reached by a click in an email, so the token is in the address bar
 * and nowhere else by the time any component mounts.
 *
 * Returns `null` rather than an empty string for a missing or blank token, so
 * the guard at a call site is one `=== null` check and a `?token=` with nothing
 * after it does not become a request the server has to refuse.
 *
 * `expectedPath` is optional and, when given, makes the read conditional on the
 * page actually being the landing page for that flow. A single page that
 * handles both links would otherwise read the reset token off the verification
 * page and present it to the wrong endpoint, which the server refuses as a
 * wrong-purpose token and which is a bug worth not writing.
 *
 * @example
 * ```ts
 * import { readLinkToken, RESET_PASSWORD_PATH } from '@webbpulse/auth';
 *
 * const token = readLinkToken({ expectedPath: RESET_PASSWORD_PATH });
 * if (token === null) {
 *   setError('This link is missing its token. Request a new one.');
 * }
 * ```
 */
export function readLinkToken(
  options: {
    /** The URL to read. Defaults to `globalThis.location.href`. */
    url?: string | URL;
    /** When given, returns null unless the URL's path matches it. */
    expectedPath?: string;
  } = {}
): string | null {
  const href =
    options.url ??
    (globalThis as { location?: { href?: string } }).location?.href;
  if (href === undefined) {
    return null;
  }
  let parsed: URL;
  try {
    // A base, so a relative href such as '/reset-password?token=t' parses. The
    // origin is discarded: only the path and the query are read.
    parsed = new URL(String(href), 'http://localhost');
  } catch {
    return null;
  }
  if (
    options.expectedPath !== undefined &&
    !pathsMatch(parsed.pathname, options.expectedPath)
  ) {
    return null;
  }
  const token = parsed.searchParams.get(LINK_TOKEN_PARAM);
  return token === null || token === '' ? null : token;
}

/**
 * Compares two paths ignoring a trailing slash.
 *
 * `/reset-password` and `/reset-password/` are the same page, and which one the
 * user's browser shows depends on the host's redirect rules rather than on
 * anything either side of this contract controls.
 */
function pathsMatch(actual: string, expected: string): boolean {
  const trim = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  return trim(actual) === trim(expected);
}

/**
 * Reads a retry hint off a 429, in seconds, when the body carried one.
 *
 * The body rather than the `Retry-After` header, which is where the server
 * actually puts it: `ApiError` keeps the parsed body, the status and the
 * request id, and does not keep the `Response`, so the header is not reachable
 * from a caught error. That is a limit of the transport rather than of this
 * function, and it is why the field is optional everywhere it appears: a form
 * that has it can count down, and one that does not says "try again shortly".
 */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
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
 * Classifies a thrown error from one of the four routes, or rethrows.
 *
 * The rule for what stays an exception: anything the caller could not have
 * anticipated and cannot render a useful form state for. A network failure, a
 * timeout and a 500 all rethrow. A 400 carrying `INVALID_LINK`, a 429, a 503
 * carrying `EMAIL_NOT_CONFIGURED` and a password policy refusal all become
 * outcomes, because each of those has a sentence a form should show next to a
 * field rather than in a crash boundary.
 *
 * `expected` is the set of reasons the calling method models, so a code that
 * would be a valid outcome on one route does not become a silent success on
 * another: `confirmEmailVerification` never returns `password-rejected`, and a
 * `PASSWORD_TOO_SHORT` arriving there would be a server bug worth throwing on.
 */
export function classifyLinkError<
  TReason extends AnyRefusal['reason'],
  TRefusal extends AnyRefusal = Extract<AnyRefusal, { reason: TReason }>,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/** Every refusal any of the four routes can produce. */
export type AnyRefusal = LinkRefused | PasswordResetRejected;

/**
 * The untyped body of {@link classifyLinkError}.
 *
 * Split out because the generic signature above cannot be checked from inside:
 * TypeScript has no way to prove a concrete `{ reason: 'rate-limited' }` object
 * satisfies an unresolved `TReason`, even though the runtime `expected.has`
 * guard is exactly that proof. The cast lives here, once, rather than at each
 * of the three call sites.
 */
function classify(
  error: unknown,
  expected: ReadonlySet<AnyRefusal['reason']>
): AnyRefusal | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const envelope = getWebbPulseError(error);
  const code = getAuthErrorCode(error);
  const rawCode = envelope.errorCode;
  const message = envelope.message;

  if (rawCode === 'INVALID_LINK' && expected.has('invalid-link')) {
    return {
      ok: false,
      reason: 'invalid-link',
      code,
      message,
      retryAfter: undefined,
    };
  }
  if (
    expected.has('password-rejected') &&
    (rawCode === 'PASSWORD_TOO_SHORT' ||
      rawCode === 'PASSWORD_TOO_LONG' ||
      rawCode === 'WEAK_PASSWORD' ||
      rawCode === 'PASSWORD_REJECTED')
  ) {
    return {
      ok: false,
      reason: 'password-rejected',
      code,
      message,
      retryAfter: undefined,
    };
  }
  if (error.status === 429 && expected.has('rate-limited')) {
    // The rate limit dependency raises a bare 429 with no error_code, so this
    // branches on the status rather than on a code that is not there. `code`
    // still carries TOO_MANY_ATTEMPTS when the per-account lockout produced it.
    return {
      ok: false,
      reason: 'rate-limited',
      code,
      message,
      retryAfter: retryAfterSeconds(error),
    };
  }
  if (rawCode === 'EMAIL_NOT_CONFIGURED' && expected.has('unavailable')) {
    return {
      ok: false,
      reason: 'unavailable',
      code,
      message,
      retryAfter: undefined,
    };
  }
  return null;
}
