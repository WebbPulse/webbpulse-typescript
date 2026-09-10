/**
 * The identity error contract, section 7.3 of the identity standard.
 *
 * The identity routes answer in the package envelope
 * (`{ success: false, status, message, request_id }` plus `error_code`), so the
 * frontend switches on `error_code` and never parses prose. `@webbpulse/api-client`
 * already models the envelope and exposes it through `getWebbPulseError`; this
 * module narrows that untyped `errorCode: string | undefined` to the closed set
 * the identity service actually emits, so a `switch` in application code is
 * exhaustive and a typo in a comparison is a compile error rather than a branch
 * that never runs.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

/**
 * The codes the frontend must handle, verbatim from 7.3.
 *
 * `PASSKEY_NOT_RECOGNISED` carries the British spelling because that is the
 * spelling the standard fixes and the backend emits. It is a wire value, not
 * prose, so it is transcribed rather than normalised.
 */
export const AUTH_ERROR_CODES = [
  'MFA_REQUIRED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'EMAIL_NOT_VERIFIED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'SESSION_REVOKED',
  'RATE_LIMITED',
  'WEAK_PASSWORD',
  'PASSWORD_TOO_LONG',
  'OAUTH_EMAIL_UNVERIFIED',
  'PASSKEY_NOT_RECOGNISED',
] as const;

/** One of the codes in {@link AUTH_ERROR_CODES}. */
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES);

/** True when a value is one of the identity error codes. */
export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

/**
 * Reads the identity `error_code` off a thrown value.
 *
 * Returns `undefined` for anything that is not an `ApiError` carrying a code
 * this module knows, which covers a network failure, a timeout, a 500 with no
 * envelope, and a code from some other domain. That is deliberate: an
 * application branching on the result gets `undefined` for "not an identity
 * outcome I model" and falls through to its generic error path, rather than
 * matching a string the standard never promised.
 *
 * @example
 * ```ts
 * try {
 *   await auth.login({ email, password });
 * } catch (error) {
 *   switch (getAuthErrorCode(error)) {
 *     case 'INVALID_CREDENTIALS':
 *       setFormError('Email or password is incorrect.');
 *       break;
 *     case 'ACCOUNT_LOCKED':
 *       setFormError('Too many attempts. Try again later.');
 *       break;
 *     default:
 *       setFormError(describeAuthError(error));
 *   }
 * }
 * ```
 */
export function getAuthErrorCode(error: unknown): AuthErrorCode | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const code = getWebbPulseError(error).errorCode;
  return isAuthErrorCode(code) ? code : undefined;
}

/**
 * The message to show for a failed identity call.
 *
 * The envelope's `message` is written by the backend for a caller to read, so
 * it is preferred. Anything without an envelope falls back to the error's own
 * message, and a non `Error` to a generic line, so a call site never has to
 * supply a fallback of its own.
 */
export function describeAuthError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
): string {
  if (error instanceof ApiError) {
    return getWebbPulseError(error).message;
  }
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return fallback;
}

/**
 * Raised when the session ends without an HTTP error to point at.
 *
 * The two cases are a silent refresh that found no usable cookie and a refresh
 * that the server refused. Both leave the client anonymous, and both need to be
 * distinguishable from a network blip by anything awaiting an auth call, which
 * a bare `Error` does not manage.
 */
export class AuthSessionEndedError extends Error {
  /** The identity code the refusal carried, when the server sent one. */
  readonly code: AuthErrorCode | undefined;
  /** Why the session ended, for a caller that logs rather than renders. */
  readonly reason: 'refresh-failed' | 'logged-out' | 'no-session';

  constructor(init: {
    message?: string;
    code?: AuthErrorCode | undefined;
    reason: 'refresh-failed' | 'logged-out' | 'no-session';
    cause?: unknown;
  }) {
    super(init.message ?? 'The session has ended.', { cause: init.cause });
    this.name = 'AuthSessionEndedError';
    this.code = init.code;
    this.reason = init.reason;
    Object.setPrototypeOf(this, AuthSessionEndedError.prototype);
  }
}
