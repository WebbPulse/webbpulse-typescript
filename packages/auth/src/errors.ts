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
 * The codes the frontend must handle.
 *
 * The first twelve are verbatim from 7.3. `PASSKEY_NOT_RECOGNISED` carries the
 * British spelling because that is the spelling the standard fixes and the
 * backend emits. These are wire values, not prose, so they are transcribed
 * rather than normalised.
 *
 * The five after them are emitted by the M3 link flows and are not in 7.3's
 * list, which was written before those routes existed. They are added here
 * rather than left to fall through `getAuthErrorCode` as `undefined`, because
 * that function's contract is that `undefined` means "not an identity outcome I
 * model", and every one of these is an identity outcome a form has to render:
 *
 * - `INVALID_LINK`: the one refusal every failed link confirmation carries.
 *   Unknown, expired, already spent and wrong purpose are deliberately one code
 *   with one message, because the difference between them is information about
 *   somebody else's token.
 * - `PASSWORD_TOO_SHORT`, `PASSWORD_REJECTED`: section 5.6's policy refusals,
 *   alongside `WEAK_PASSWORD` and `PASSWORD_TOO_LONG` which 7.3 already names.
 * - `TOO_MANY_ATTEMPTS`: the per-account lockout, which is distinct from
 *   `RATE_LIMITED` and is what the backend actually emits.
 * - `EMAIL_NOT_CONFIGURED`: an identity deployment with no sender. A fault
 *   rather than a user error, and worth telling apart from a rate limit.
 *
 * The six after those are emitted by the M4 MFA routes, and are added for the
 * same reason:
 *
 * - `INVALID_MFA_CODE`: the one refusal every failed factor check carries.
 *   Wrong code, replayed code, no factor enrolled, a factor enrolled but not
 *   activated, a spent recovery code and one that never existed are deliberately
 *   one code with one message, so the second leg of login cannot be used to
 *   discover which accounts have TOTP enabled.
 * - `MFA_TICKET_INVALID`: the ticket expired or was already spent. The remedy
 *   is to start the sign in again, which is a different sentence from a wrong
 *   code and so is worth telling apart.
 * - `TOTP_ALREADY_ENABLED`, `NO_PENDING_ENROLMENT`: the two 409s of the
 *   enrolment routes.
 * - `MFA_NOT_CONFIGURED`: a deployment whose MFA routes exist but whose service
 *   does not. A fault rather than a user error.
 * - `NOT_AUTHENTICATED`: what the five authorized identity routes answer to a
 *   caller with no usable bearer token. Named here so a `switch` can see it,
 *   though the MFA methods never turn it into an outcome: it means the session
 *   ended, which is not a form field error.
 *
 * The last group is emitted by the M6 OAuth routes. `OAUTH_EMAIL_UNVERIFIED` was
 * already in 7.3's list and is above; these are the rest, and they are added on
 * the same rule as the others, that every one of them is an identity outcome a
 * page has to render:
 *
 * - `OAUTH_LAST_SIGN_IN_METHOD`: an unlink that would leave the account with no
 *   way in. The only refusal in the set whose remedy is a specific instruction
 *   ("set a password first"), which is why it is a named outcome rather than a
 *   thrown 409.
 * - `OAUTH_ALREADY_LINKED`, `OAUTH_NOT_LINKED`: the provider identity is
 *   attached to an account already, or is not attached to this one. Usually a
 *   stale settings page, and the remedy is a reload.
 * - `OAUTH_PROVIDER_UNKNOWN`, `OAUTH_PROVIDER_UNAVAILABLE`: a name the server
 *   does not know, and a name it knows but has no client id for. Both are
 *   deployment faults rather than user errors.
 * - `OAUTH_CANCELLED`: the user pressed Cancel on the consent screen. Not an
 *   error, and a landing page should not render it as one.
 * - `OAUTH_STATE_INVALID`, `OAUTH_REDIRECT_NOT_ALLOWED`: an expired or replayed
 *   authorization, and a redirect URI outside the allow-list.
 * - `OAUTH_EXCHANGE_FAILED`, `OAUTH_USERINFO_FAILED`, `OAUTH_ID_TOKEN_INVALID`,
 *   `OAUTH_NONCE_MISMATCH`, `OAUTH_CODE_MISSING`, `OAUTH_EMAIL_MISSING`,
 *   `OAUTH_ACCOUNT_MISSING`: the provider leg went wrong. Named so a log line
 *   records which, though a user sees one sentence for all of them.
 * - `REGISTRATION_DISABLED`: a first-time provider identity arriving at a
 *   product that is not creating accounts.
 *
 * The last group is emitted by the M5 passkey routes, and is added on the same
 * rule again. Note that `PASSKEY_NOT_RECOGNISED` above is 7.3's code and is a
 * different thing from these: it is what the standard names for a credential
 * the server does not know, while the seven routes actually emit
 * `PASSKEY_REJECTED` for that case along with four others.
 *
 * - `PASSKEY_REJECTED`: the one refusal every failed ceremony carries. A
 *   challenge that does not exist, one that expired, one minted for another
 *   account, an assertion that does not verify, a credential the server does
 *   not know and a credential whose user is gone are deliberately one code with
 *   one message, so neither login route becomes an oracle for which credentials
 *   or accounts exist.
 * - `PASSKEY_ALREADY_REGISTERED`: the authenticator already holds a credential
 *   for some account. One answer whether it is this account or another, for the
 *   same reason: telling them apart would let somebody test which accounts an
 *   authenticator is enrolled on.
 * - `LAST_CREDENTIAL`: a delete that would leave an account with no password
 *   and no passkey. The only passkey refusal whose remedy is a specific
 *   instruction, "set a password first", which is why it is a named outcome
 *   rather than a thrown 409.
 * - `PASSKEY_NOT_FOUND`, `PASSKEY_NAME_REQUIRED`: no such credential on this
 *   account, and a rename with an empty name.
 * - `PASSKEY_CHALLENGE_INVALID`: the challenge row was missing, spent or past
 *   its five minute deadline. Reached mostly by a stale tab, and the remedy is
 *   to start the ceremony again.
 * - `PASSKEY_LOGIN_DISABLED`, `PASSKEYS_DISABLED`: passwordless sign-in is off
 *   for this deployment, and passkeys are off altogether. Both are deployment
 *   configuration rather than user error, and a page should hide the control
 *   rather than render a failure.
 * - `CREDENTIAL_REQUIRED`: a verify leg posted with no credential in the body.
 *   A client bug rather than a user one, named so a log line can say so.
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
