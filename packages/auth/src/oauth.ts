/**
 * The client half of the identity service's OAuth surface: federated sign-in
 * with Google and GitHub, and the settings-page management of the links it
 * creates. The start route is a browser navigation rather than a `fetch`, and
 * the callback returns the session in the ordinary refresh cookie plus one
 * query parameter that {@link readOAuthCallback} narrows.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import {
  type AuthErrorCode,
  getAuthErrorCode,
  isAuthErrorCode,
} from './errors.js';

/**
 * The two providers in the standard's mandatory baseline. Not a closed set: a
 * product that configures a third passes its name as a string and every method
 * works unchanged.
 */
export const GOOGLE_PROVIDER = 'google';

/** @see {@link GOOGLE_PROVIDER} */
export const GITHUB_PROVIDER = 'github';

/**
 * The query parameter a successful sign-in callback lands with. The value
 * carries no information; the session itself is in the cookie.
 */
export const OAUTH_RESULT_PARAM = 'oauth';

/** The parameter a successful `link` callback lands with. Value is always `"1"`. */
export const OAUTH_LINKED_PARAM = 'oauth_linked';

/**
 * The parameter carrying an MFA ticket when the account has a second factor.
 * The same ticket the password path receives, posted to the same route.
 */
export const OAUTH_MFA_TICKET_PARAM = 'mfa_ticket';

/**
 * The parameter carrying a refusal code. Only the identity service's own codes
 * appear here: a provider's `error_description` is attacker-influenced and is
 * never put in the URL.
 */
export const OAUTH_ERROR_PARAM = 'oauth_error';

/** Every parameter the callback redirect can add, for {@link stripOAuthParams}. */
export const OAUTH_CALLBACK_PARAMS = [
  OAUTH_RESULT_PARAM,
  OAUTH_LINKED_PARAM,
  OAUTH_MFA_TICKET_PARAM,
  OAUTH_ERROR_PARAM,
] as const;

/**
 * Whether an authorization is a sign-in or an attach to an existing account.
 * Recorded on the server-side state row rather than read off the callback URL,
 * which is what stops a sign-in callback being steered into an attach.
 */
export type OAuthMode = 'login' | 'link';

/** Options for building an authorization URL. */
export interface OAuthStartOptions {
  /**
   * Where the frontend should land after the callback: a path resolved against
   * the configured frontend base URL, or an absolute URL on that origin.
   * Anything else falls back to the frontend root rather than being refused.
   */
  returnTo?: string;
  /** Defaults to `'login'` on the server when omitted. */
  mode?: OAuthMode;
  /**
   * A specific registered redirect URI, for a product with more than one host.
   * Matched against the server's allow-list by exact string equality. Leave it
   * out and the server uses its default.
   */
  redirectUri?: string;
}

/** A sign-in that completed. The refresh cookie is set; nothing else is needed. */
export interface OAuthSignedIn {
  kind: 'signed-in';
}

/** A sign-in waiting on a second factor. */
export interface OAuthMfaRequired {
  kind: 'mfa-required';
  /**
   * The single-use ticket to hand to `completeTotp`. Short lived, and it is in a
   * URL, so read it once and clear it. See {@link stripOAuthParams}.
   */
  ticket: string;
}

/** A provider that was attached to the signed-in account. */
export interface OAuthLinked {
  kind: 'linked';
}

/** A callback the server refused, or a consent screen the user cancelled. */
export interface OAuthCallbackFailed {
  kind: 'error';
  /**
   * The identity code, when it is one this package models. `undefined` for a
   * code this version does not know, so a caller falls through to a generic
   * message rather than rendering a raw wire value.
   */
  code: AuthErrorCode | undefined;
  /**
   * The raw code exactly as the URL carried it, kept so a log line records what
   * arrived even when this version cannot name it.
   */
  rawCode: string;
}

/**
 * What a landing page finds in its URL after an OAuth callback. `null` means the
 * page was not reached from a callback.
 */
export type OAuthCallbackResult =
  OAuthSignedIn | OAuthMfaRequired | OAuthLinked | OAuthCallbackFailed;

/** One provider attached to the signed-in account. */
export interface OAuthLink {
  /** `'google'`, `'github'`, or whatever the product configured. */
  provider: string;
  /**
   * The address the provider holds for this user, when it gave one. The
   * provider's own record rather than the local account's, so a user with two
   * provider accounts can tell which is attached.
   */
  email: string;
  /** Whether the provider says it verified that address. */
  emailVerified: boolean;
  /** ISO 8601 instant the link was created. */
  linkedAt: string;
  /** ISO 8601 instant of the most recent sign-in through it, when there is one. */
  lastLoginAt: string | undefined;
}

/**
 * The fields every OAuth refusal carries. `reason` is added by each member below
 * rather than declared here as a union, so `Extract` narrows to one member.
 */
interface OAuthRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  /** The server's own sentence. Render this rather than a local one. */
  message: string;
}

/**
 * An unlink refused because it would leave the account with no way in. The
 * server counts what would remain before deleting, and the remedy is to set a
 * password first, which is why this is a named outcome.
 */
export interface OAuthLastSignInMethod extends OAuthRefusalFields {
  reason: 'last-sign-in-method';
}

/**
 * A provider that is not attached to this account, usually a stale settings
 * page. The remedy is to reload the list.
 */
export interface OAuthNotLinked extends OAuthRefusalFields {
  reason: 'not-linked';
}

/**
 * A provider identity already attached to some account. The server refuses
 * rather than silently moving the link, and does not say which account holds
 * it, since that is information about that account.
 */
export interface OAuthAlreadyLinked extends OAuthRefusalFields {
  reason: 'already-linked';
}

/**
 * A provider this deployment cannot use: either the name is unknown or it is
 * known but unconfigured. Both are deployment faults, and a settings page
 * renders the same unavailable state for either.
 */
export interface OAuthProviderUnavailable extends OAuthRefusalFields {
  reason: 'provider-unavailable';
}

/**
 * A rate limit. Section 5.1 puts the start route at 20 per 15 minutes per IP.
 */
export interface OAuthRateLimited extends OAuthRefusalFields {
  reason: 'rate-limited';
  /**
   * Seconds to wait, when the server said. Read from the `Retry-After` header,
   * falling back to a `retry_after` hint in the envelope's `details`.
   */
  retryAfter: number | undefined;
}

/** Every refusal the three management routes can produce. */
export type OAuthRefusal =
  | OAuthLastSignInMethod
  | OAuthNotLinked
  | OAuthAlreadyLinked
  | OAuthProviderUnavailable
  | OAuthRateLimited;

/** A link authorization the server started for a signed-in caller. */
export interface OAuthLinkStarted {
  ok: true;
  /**
   * Where to send the browser to finish attaching the provider. Assign it to
   * `location.href`: it points at another origin and is not CORS-readable.
   */
  authorizationUrl: string;
}

/** What {@link AuthClient.linkOAuthProvider} resolves to. */
export type OAuthLinkOutcome =
  | OAuthLinkStarted
  | OAuthAlreadyLinked
  | OAuthProviderUnavailable
  | OAuthRateLimited;

/** The links on the account, newest field set first as the server returned them. */
export interface OAuthLinksLoaded {
  ok: true;
  links: OAuthLink[];
}

/** What {@link AuthClient.listOAuthLinks} resolves to. */
export type OAuthLinksOutcome = OAuthLinksLoaded | OAuthProviderUnavailable;

/** A provider that was detached. */
export interface OAuthUnlinked {
  ok: true;
}

/** What {@link AuthClient.unlinkOAuthProvider} resolves to. */
export type OAuthUnlinkOutcome =
  | OAuthUnlinked
  | OAuthLastSignInMethod
  | OAuthNotLinked
  | OAuthProviderUnavailable;

/** Where the OAuth routes live, relative to the base URL. */
export interface OAuthPaths {
  /**
   * Defaults to `/api/auth/oauth`, the prefix the authorization and link routes
   * hang off after their provider segment.
   */
  oauthStart?: string;
  /**
   * Defaults to `/api/auth/oauth/links`. A field of its own rather than derived
   * from `oauthStart`, so moving one prefix does not silently move the other.
   */
  oauthLinks?: string;
}

/**
 * Reads a retry hint in seconds off a 429: the `Retry-After` header first, which
 * is where the rate limit dependency puts it, then a `retry_after` in the
 * envelope's `details`.
 */
function retryAfterOf(error: ApiError): number | undefined {
  if (error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds;
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
 * Classifies a thrown error from one of the three management routes, or returns
 * null. `expected` is the set of reasons the calling method models, so a refusal
 * that is an outcome on one route cannot become a silent success on another. A
 * 401 is left unclassified, since the transport has already tried to repair it.
 */
export function classifyOAuthError<
  TReason extends OAuthRefusal['reason'],
  TRefusal extends OAuthRefusal = Extract<OAuthRefusal, { reason: TReason }>,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/**
 * The untyped body of {@link classifyOAuthError}. Split out because TypeScript
 * cannot prove a concrete reason object satisfies an unresolved `TReason`, so
 * the cast lives here once rather than at each call site.
 */
function classify(
  error: unknown,
  expected: ReadonlySet<OAuthRefusal['reason']>
): OAuthRefusal | null {
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

  if (
    rawCode === 'OAUTH_LAST_SIGN_IN_METHOD' &&
    expected.has('last-sign-in-method')
  ) {
    return { ...base, reason: 'last-sign-in-method' };
  }
  if (rawCode === 'OAUTH_NOT_LINKED' && expected.has('not-linked')) {
    return { ...base, reason: 'not-linked' };
  }
  if (rawCode === 'OAUTH_ALREADY_LINKED' && expected.has('already-linked')) {
    return { ...base, reason: 'already-linked' };
  }
  if (
    (rawCode === 'OAUTH_PROVIDER_UNKNOWN' ||
      rawCode === 'OAUTH_PROVIDER_UNAVAILABLE') &&
    expected.has('provider-unavailable')
  ) {
    return { ...base, reason: 'provider-unavailable' };
  }
  if (error.status === 429 && expected.has('rate-limited')) {
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}

/**
 * Reads the callback outcome off a URL, or returns null. Pass `location.href` on
 * the page the callback redirected to. Precedence when more than one parameter
 * is present is error, ticket, link, sign-in, so a stale parameter cannot
 * outrank a live refusal.
 *
 * @example
 * ```ts
 * const result = readOAuthCallback(window.location.href);
 * switch (result?.kind) {
 *   case 'signed-in':
 *     await auth.initialize();
 *     break;
 *   case 'mfa-required':
 *     setPendingTicket(result.ticket);
 *     break;
 *   case 'linked':
 *     await reloadLinks();
 *     break;
 *   case 'error':
 *     setBanner(describeOAuthError(result));
 *     break;
 * }
 * history.replaceState(null, '', stripOAuthParams(window.location.href));
 * ```
 */
export function readOAuthCallback(
  href: string | null | undefined
): OAuthCallbackResult | null {
  const params = searchParamsOf(href);
  if (params === null) {
    return null;
  }

  const error = params.get(OAUTH_ERROR_PARAM);
  if (error !== null && error !== '') {
    return {
      kind: 'error',
      code: isKnownOAuthCode(error) ? error : undefined,
      rawCode: error,
    };
  }

  const ticket = params.get(OAUTH_MFA_TICKET_PARAM);
  if (ticket !== null && ticket !== '') {
    return { kind: 'mfa-required', ticket };
  }

  if (params.get(OAUTH_LINKED_PARAM) !== null) {
    return { kind: 'linked' };
  }

  if (params.get(OAUTH_RESULT_PARAM) !== null) {
    return { kind: 'signed-in' };
  }

  return null;
}

/**
 * Removes every callback parameter from a URL, leaving the rest untouched. Feed
 * the result to `history.replaceState`, so a live MFA ticket does not sit in the
 * browser history and a reload does not re-run the landing logic. Returns the
 * input unchanged when it does not parse.
 */
export function stripOAuthParams(href: string): string {
  let parsed: URL;
  try {
    parsed = new URL(href, 'http://localhost');
  } catch {
    return href;
  }
  for (const param of OAUTH_CALLBACK_PARAMS) {
    parsed.searchParams.delete(param);
  }
  const relative =
    !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href) && !href.startsWith('//');
  const rebuilt = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return relative ? rebuilt : `${parsed.origin}${rebuilt}`;
}

/**
 * The message to show for a failed callback. A callback failure arrives as a
 * code in a URL and nothing else, so these sentences are local rather than the
 * server's. `OAUTH_CANCELLED` reads flat, because pressing Cancel is not an
 * error.
 */
export function describeOAuthCallbackError(
  result: OAuthCallbackFailed,
  fallback = 'Could not finish signing in with that provider.'
): string {
  switch (result.rawCode) {
    case 'OAUTH_CANCELLED':
      return 'Sign-in was cancelled.';
    case 'OAUTH_EMAIL_UNVERIFIED':
      return 'That provider account uses an address we cannot confirm belongs to you. Sign in with your password, then link the provider from your security settings.';
    case 'OAUTH_ALREADY_LINKED':
      return 'That provider account is already linked to an account.';
    case 'OAUTH_STATE_INVALID':
      return 'That sign-in link has expired. Please try again.';
    case 'OAUTH_PROVIDER_UNKNOWN':
    case 'OAUTH_PROVIDER_UNAVAILABLE':
      return 'That provider is not available right now.';
    case 'REGISTRATION_DISABLED':
      return 'New accounts are not being created right now.';
    case 'ACCOUNT_LOCKED':
      return 'That account is locked. Try again later.';
    default:
      return fallback;
  }
}

/**
 * Reads the `links` array off the list route's body, defending each field rather
 * than trusting the shape, because this crosses a repository boundary with
 * nothing enforcing it at build time.
 */
export function parseOAuthLinks(body: unknown): OAuthLink[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const raw = (body as { links?: unknown }).links;
  if (!Array.isArray(raw)) {
    return [];
  }
  const links: OAuthLink[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const provider = record['provider'];
    if (typeof provider !== 'string' || provider === '') {
      continue;
    }
    const lastLoginAt = record['last_login_at'];
    links.push({
      provider,
      email: typeof record['email'] === 'string' ? record['email'] : '',
      emailVerified: record['email_verified'] === true,
      linkedAt:
        typeof record['linked_at'] === 'string' ? record['linked_at'] : '',
      lastLoginAt:
        typeof lastLoginAt === 'string' && lastLoginAt !== ''
          ? lastLoginAt
          : undefined,
    });
  }
  return links;
}

/** Parses a URL's query string, tolerating a relative href and a bad one. */
function searchParamsOf(
  href: string | null | undefined
): URLSearchParams | null {
  if (typeof href !== 'string' || href === '') {
    return null;
  }
  try {
    return new URL(href, 'http://localhost').searchParams;
  } catch {
    return null;
  }
}

/**
 * Narrows a raw callback code to the modelled set. A code this version does not
 * name falls through to `rawCode` with `code: undefined`, which is why
 * {@link describeOAuthCallbackError} switches on `rawCode`.
 */
function isKnownOAuthCode(value: string): value is AuthErrorCode {
  return isAuthErrorCode(value);
}
