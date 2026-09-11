/**
 * The two link-based identity flows, email verification and password reset. The
 * four methods resolve to outcomes rather than throwing, because an expired
 * link, a rejected password and a rate limit are answers a form renders inline.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * The SPA path a verification link lands on. Must equal the backend's
 * `VERIFY_LINK_PATH`, which is what it concatenates onto `frontend_base_url`;
 * both sides carry a test asserting the literal.
 */
export const VERIFY_EMAIL_PATH = '/verify-email';

/**
 * The SPA path a password reset link lands on. Not the API route: this is the
 * page that collects the new password and calls the confirm endpoint.
 */
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * The query parameter the token arrives in. A query parameter rather than a
 * path segment, which a router would log as a route and put in an access log.
 */
export const LINK_TOKEN_PARAM = 'token';

/**
 * A verification or reset request the server accepted. There is no `sent:
 * false`: the request endpoints answer identically whether or not the address
 * has an account.
 */
export interface EmailRequestSent {
  ok: true;
  /**
   * The server's message, when it sent one. Rendering the server's copy keeps
   * one wording for a sentence phrased to promise nothing.
   */
  detail: string | undefined;
}

/**
 * The fields every refusal carries. `reason` is added by each member below
 * rather than declared here as a union, so `Extract` narrows to one member
 * instead of forcing each method to cast its result.
 */
interface RefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  message: string;
  /**
   * Seconds to wait before retrying, when the body carried a hint. Frequently
   * `undefined`, since the server puts the wait in a header. See
   * {@link retryAfterSeconds}.
   */
  retryAfter: number | undefined;
}

/** A rate limit, per address and per IP, plus the per-account lockout. */
export interface RateLimited extends RefusalFields {
  reason: 'rate-limited';
}

/**
 * An identity deployment with no sender configured. A deployment fault rather
 * than a user error, so "try again in an hour" would be a lie.
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
 * A link the server refused. One case for unknown, expired, already used and
 * wrong purpose, because naming which would confirm that a guessed value found
 * a real token.
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
 * A reset refused because the new password failed the policy. Separate from
 * {@link LinkRefused} because the remedy differs: the link is spent, so ask for
 * a new one and choose a different password.
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
 * Reads the link token out of a URL, defaulting to the current location, since
 * a landing page is reached by a click in an email. Returns `null` for a
 * missing or blank token, and `expectedPath` makes the read conditional on the
 * page being that flow's landing page.
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
 * Compares two paths ignoring a trailing slash, since which form the browser
 * shows depends on the host's redirect rules.
 */
function pathsMatch(actual: string, expected: string): boolean {
  const trim = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  return trim(actual) === trim(expected);
}

/**
 * Reads a retry hint off a 429 body, in seconds, when one was sent. The body
 * rather than the header, which is not reachable from a caught `ApiError`, so
 * the field is optional everywhere it appears.
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
 * Classifies a thrown error from one of the four routes, or rethrows. A network
 * failure, a timeout and a 500 rethrow; a refused link, a rate limit, a missing
 * sender and a password policy refusal become outcomes. `expected` keeps a code
 * that is valid on one route from becoming a silent success on another.
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
 * The untyped body of {@link classifyLinkError}. Split out because TypeScript
 * cannot prove a concrete reason object satisfies an unresolved `TReason`, so
 * the cast lives here once rather than at each call site.
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
