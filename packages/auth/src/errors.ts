/**
 * The identity error contract. Narrows the envelope's untyped `error_code` to
 * the closed set the identity service emits, so an application switches on it
 * exhaustively and a typo in a comparison is a compile error.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

/**
 * The identity error codes the frontend must handle, as wire values: British
 * spellings are transcribed rather than normalised. A code absent from this set
 * reads as `undefined`, meaning an outcome this package does not model.
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
  'INVALID_LINK',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_REJECTED',
  'TOO_MANY_ATTEMPTS',
  'EMAIL_NOT_CONFIGURED',
  'INVALID_MFA_CODE',
  'MFA_TICKET_INVALID',
  'TOTP_ALREADY_ENABLED',
  'NO_PENDING_ENROLMENT',
  'MFA_NOT_CONFIGURED',
  'NOT_AUTHENTICATED',
  'OAUTH_LAST_SIGN_IN_METHOD',
  'OAUTH_ALREADY_LINKED',
  'OAUTH_NOT_LINKED',
  'OAUTH_PROVIDER_UNKNOWN',
  'OAUTH_PROVIDER_UNAVAILABLE',
  'OAUTH_CANCELLED',
  'OAUTH_STATE_INVALID',
  'OAUTH_REDIRECT_NOT_ALLOWED',
  'OAUTH_EXCHANGE_FAILED',
  'OAUTH_USERINFO_FAILED',
  'OAUTH_ID_TOKEN_INVALID',
  'OAUTH_NONCE_MISMATCH',
  'OAUTH_CODE_MISSING',
  'OAUTH_EMAIL_MISSING',
  'OAUTH_ACCOUNT_MISSING',
  'REGISTRATION_DISABLED',
  'PASSKEY_REJECTED',
  'PASSKEY_ALREADY_REGISTERED',
  'PASSKEY_NOT_FOUND',
  'PASSKEY_NAME_REQUIRED',
  'PASSKEY_CHALLENGE_INVALID',
  'PASSKEY_LOGIN_DISABLED',
  'PASSKEYS_DISABLED',
  'LAST_CREDENTIAL',
  'CREDENTIAL_REQUIRED',
] as const;

/** One of the codes in {@link AUTH_ERROR_CODES}. */
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(AUTH_ERROR_CODES);

/** True when a value is one of the identity error codes. */
export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

/**
 * Reads the identity `error_code` off a thrown value, or `undefined` when the
 * value is not an `ApiError` carrying a code this module models, so a caller
 * falls through to its generic error path rather than matching a guess.
 */
export function getAuthErrorCode(error: unknown): AuthErrorCode | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const code = getWebbPulseError(error).errorCode;
  return isAuthErrorCode(code) ? code : undefined;
}

/**
 * The message to show for a failed identity call, preferring the envelope's
 * own `message`. Never empty, so a call site needs no fallback.
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
 * Raised when the session ends with no HTTP error to point at: a silent
 * refresh that found no cookie, or one the server refused.
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
