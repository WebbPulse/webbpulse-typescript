/**
 * The client half of the identity service's M6 surface: federated sign-in with
 * Google and GitHub, and the settings-page management of the links it creates.
 *
 * Five routes on the server, and they are deliberately not five methods of the
 * same shape here, because two of them are **browser navigations rather than
 * API calls**:
 *
 * | Route | What the client does |
 * | --- | --- |
 * | `GET /oauth/{provider}/start` | builds a URL and lets the page leave |
 * | `GET /oauth/callback` | nothing: the browser lands on the frontend |
 * | `POST /oauth/{provider}/link` | ordinary `fetch` with a bearer token |
 * | `GET /oauth/links` | ordinary `fetch` with a bearer token |
 * | `DELETE /oauth/{provider}/link` | ordinary `fetch` with a bearer token |
 *
 * A cross-origin redirect to a provider cannot be followed by script and the
 * provider's answer is not CORS-readable, so `start` is unreachable by `fetch`
 * by construction. {@link AuthClient.oauthStartUrl} therefore hands back the URL
 * and {@link AuthClient.startOAuth} assigns it, and neither returns a promise
 * there would be nothing to resolve.
 *
 * ## How the session gets back to the SPA
 *
 * The callback runs on the API, not in the SPA, and it finishes by redirecting
 * the browser to the frontend. There is **no one-time code to exchange**: the
 * server sets the ordinary refresh cookie on that redirect, using the same
 * writer the password login uses, so the cookie attributes cannot drift between
 * the two paths. What arrives at the frontend is one query parameter saying
 * which of four things happened:
 *
 * | Parameter | Meaning | What the SPA does |
 * | --- | --- | --- |
 * | `?oauth=1` | signed in, refresh cookie set | `auth.initialize()` |
 * | `?mfa_ticket=<t>` | account has a second factor | `auth.completeTotp({ ticket, code })` |
 * | `?oauth_linked=1` | a provider was attached | refresh the settings list |
 * | `?oauth_error=<CODE>` | refused, or the user cancelled | render the code |
 *
 * {@link readOAuthCallback} reads whichever one is present off a URL and
 * narrows it to a discriminated union, so a landing page is a `switch` rather
 * than four `searchParams.get` calls and a guess at precedence.
 *
 * **The access token is not in the URL, and never should be.** It arrives the
 * way it always does: `initialize()` spends the refresh cookie and holds the
 * access token in memory. A token in a query string is in the browser history,
 * in the `Referer` of the next request, and in whatever proxy logged the
 * navigation, which is the reason the standard puts the refresh token in an
 * httpOnly cookie in the first place.
 *
 * **The MFA ticket is in the URL, and that is a considered trade.** The browser
 * is mid-navigation, so the challenge cannot be answered with a JSON body the
 * way the password path answers it: the frontend has to render a code prompt.
 * The ticket is short-lived and single use for exactly this reason, and it is
 * the same exposure the emailed link flows accept. Clear it off the URL once it
 * is read, which is what `stripOAuthParams` is for.
 *
 * ## Why the three management calls return outcomes rather than throwing
 *
 * The same rule the link and MFA flows follow: a refusal a settings page has to
 * render inline is an outcome, and anything the caller could not have
 * anticipated stays an exception. Unlinking has one refusal that is entirely
 * ordinary and entirely expected, `OAUTH_LAST_SIGN_IN_METHOD`, and it needs a
 * specific sentence rather than a generic error, because the remedy is "set a
 * password first" and no generic handler can know to say that.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import {
  type AuthErrorCode,
  getAuthErrorCode,
  isAuthErrorCode,
} from './errors.js';

/**
 * The two providers in the standard's mandatory baseline.
 *
 * Mirrors `GOOGLE_PROVIDER` and `GITHUB_PROVIDER` in `webbpulse.identity.oauth`.
 * The client sends the provider as a path segment and the server refuses an
 * unknown one with `OAUTH_PROVIDER_UNKNOWN`, so nothing here is a closed set:
 * a product that configures a third provider passes its name as a string and
 * every method works unchanged.
 */
export const GOOGLE_PROVIDER = 'google';

/** @see {@link GOOGLE_PROVIDER} */
export const GITHUB_PROVIDER = 'github';

/**
 * The query parameter a successful sign-in callback lands with.
 *
 * Must equal the flag `oauth_routes.py` writes on its success redirect. The
 * value is always `"1"` and carries no information: the parameter's presence is
 * the whole message, because the session itself is in the cookie.
 */
export const OAUTH_RESULT_PARAM = 'oauth';

/** The parameter a successful `link` callback lands with. Value is always `"1"`. */
export const OAUTH_LINKED_PARAM = 'oauth_linked';

/**
 * The parameter carrying an MFA ticket when the account has a second factor.
 *
 * The same ticket the password path receives in a JSON body, and it is posted
 * to the same route: `completeTotp({ ticket, code })`.
 */
export const OAUTH_MFA_TICKET_PARAM = 'mfa_ticket';

/**
 * The parameter carrying a refusal code.
 *
 * Only the identity service's own codes ever appear here. A provider's
 * `error_description` is attacker-influenced through the `code` parameter and
 * would be rendered into a page, so the server never puts one in the URL.
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
 *
 * Recorded on the server-side state row rather than read off the callback URL,
 * which is what stops a `login` callback being steered into attaching a
 * provider to somebody's account. The client sends it once, at the start.
 */
export type OAuthMode = 'login' | 'link';

/** Options for building an authorization URL. */
export interface OAuthStartOptions {
  /**
   * Where the frontend should land after the callback.
   *
   * A path such as `/settings/security`, resolved against the product's
   * configured frontend base URL, or an absolute URL under that same origin.
   * Anything else is not refused: the server falls back to the frontend root,
   * because a bad `return_to` is a broken link rather than an attack to show
   * the user an error page for.
   */
  returnTo?: string;
  /** Defaults to `'login'` on the server when omitted. */
  mode?: OAuthMode;
  /**
   * A specific registered redirect URI, for a product with more than one host.
   *
   * Matched against the server's allow-list by exact string equality, and
   * refused with `OAUTH_REDIRECT_NOT_ALLOWED` otherwise. Leave it out and the
   * server uses its default, which is the ordinary case.
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
   * The single-use ticket to hand to `completeTotp`.
   *
   * Short lived, and it is in a URL, so read it once and clear it. See
   * {@link stripOAuthParams}.
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
   * The identity code, when it is one this package models.
   *
   * `undefined` for a code from a future server that this version does not know
   * about, which is the same contract `getAuthErrorCode` has everywhere else:
   * fall through to a generic message rather than render a raw wire value.
   */
  code: AuthErrorCode | undefined;
  /**
   * The raw code exactly as the URL carried it.
   *
   * Kept alongside `code` so a log line records what actually arrived even when
   * this version cannot name it.
   */
  rawCode: string;
}

/**
 * What a landing page finds in its URL after an OAuth callback.
 *
 * `null` means the page was not reached from a callback, which is the ordinary
 * case for every direct visit and every reload after the parameters were
 * cleared.
 */
export type OAuthCallbackResult =
  OAuthSignedIn | OAuthMfaRequired | OAuthLinked | OAuthCallbackFailed;

/** One provider attached to the signed-in account. */
export interface OAuthLink {
  /** `'google'`, `'github'`, or whatever the product configured. */
  provider: string;
  /**
   * The address the provider holds for this user, when it gave one.
   *
   * The provider's own record, not the local account's, and the two can differ.
   * Shown so a user with two Google accounts can tell which one is attached.
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
 * The fields every OAuth refusal carries.
 *
 * `reason` is added by each member below rather than declared here as a union,
 * for the reason `RefusalFields` in `email-flows.ts` gives: a single interface
 * with a union-typed `reason` does not narrow under `Extract`, and each method
 * would have to cast its result back to the subset it returns.
 */
interface OAuthRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  /** The server's own sentence. Render this rather than a local one. */
  message: string;
}

/**
 * An unlink refused because it would leave the account with no way in.
 *
 * The server counts what would remain: other provider links, a password
 * credential, and whatever the product's own `has_other_sign_in_method` hook
 * reports, which is where passkeys are counted. Only if something remains does
 * it delete.
 *
 * The message a settings page shows for this one matters. The remedy is "set a
 * password first, then unlink", and a generic failure toast does not say that,
 * which is the entire reason this is a named outcome rather than a thrown 409.
 */
export interface OAuthLastSignInMethod extends OAuthRefusalFields {
  reason: 'last-sign-in-method';
}

/**
 * A provider that is not attached to this account.
 *
 * Usually a stale settings page: the link was removed in another tab, or the
 * button was pressed twice. The remedy is to reload the list.
 */
export interface OAuthNotLinked extends OAuthRefusalFields {
  reason: 'not-linked';
}

/**
 * A provider identity already attached to some account.
 *
 * The server refuses rather than moving the link, because moving one silently
 * detaches it from an account whose owner did not ask for that. When the
 * account it is attached to is the caller's own, the remedy is "it is already
 * linked"; when it is somebody else's, the remedy is to sign in to that one.
 * The client cannot tell the two apart and deliberately does not try: which
 * account holds a given provider identity is information about that account.
 */
export interface OAuthAlreadyLinked extends OAuthRefusalFields {
  reason: 'already-linked';
}

/**
 * A provider this deployment cannot use.
 *
 * Either the name is not one the server knows (`OAUTH_PROVIDER_UNKNOWN`) or it
 * is known but has no client id or secret configured
 * (`OAUTH_PROVIDER_UNAVAILABLE`). Both are deployment faults rather than user
 * errors, which is why they are one case: a user can do nothing about either,
 * and a settings page renders the same "not available" state for both.
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
   * Seconds to wait, when the server said.
   *
   * Read from the `Retry-After` header that `@webbpulse/api-client` now keeps
   * on `ApiError`, falling back to a `retry_after` hint in the envelope's
   * `details`. Frequently `undefined`, and a form that has it can count down
   * while one that does not says "try again shortly".
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
   * Where to send the browser to finish attaching the provider.
   *
   * Assign it to `location.href`. It is not fetched: it points at the provider,
   * which is another origin and not CORS-readable.
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
   * Defaults to `/api/auth/oauth`.
   *
   * The prefix the five routes hang off: a provider and `/start` for the
   * authorization, and a provider and `/link` for the attach and the detach.
   */
  oauthStart?: string;
  /**
   * Defaults to `/api/auth/oauth/links`.
   *
   * A field of its own rather than derived from `oauthStart`, because the list
   * route has no provider segment and deriving it would make the two overrides
   * silently coupled: a product that moved the prefix would move the list with
   * it whether or not it meant to.
   */
  oauthLinks?: string;
}

/**
 * Reads a retry hint in seconds off a 429.
 *
 * The `Retry-After` header first, which is where the rate limit dependency
 * actually puts it and which `@webbpulse/api-client` keeps on `ApiError` as of
 * 0.7.0, then a `retry_after` in the envelope's `details` for a server that
 * sent one there instead. Preferring the header is the change from the older
 * body-only readers in `email-flows.ts` and `mfa.ts`, and it is why this one is
 * frequently defined where those two are frequently `undefined`.
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
 * null.
 *
 * `expected` is the set of reasons the calling method models, so a refusal that
 * is a legitimate outcome on one route cannot become a silent success on
 * another: `listOAuthLinks` never returns `last-sign-in-method`, and one
 * arriving there would be a server bug worth throwing on.
 *
 * A 401 carrying `NOT_AUTHENTICATED` is deliberately **not** classified, for
 * the reason `classifyMfaError` gives: it means the bearer token was missing or
 * dead, which `@webbpulse/api-client` has already tried to repair with one
 * refresh and one replay, and turning it into an outcome would hide a session
 * that ended behind a settings-page error state.
 */
export function classifyOAuthError<
  TReason extends OAuthRefusal['reason'],
  TRefusal extends OAuthRefusal = Extract<OAuthRefusal, { reason: TReason }>,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/**
 * The untyped body of {@link classifyOAuthError}.
 *
 * Split out for the reason `classify` in `email-flows.ts` is: TypeScript cannot
 * prove a concrete `{ reason: 'rate-limited' }` satisfies an unresolved
 * `TReason`, even though the runtime `expected.has` guard is exactly that
 * proof. The cast lives here once rather than at each call site.
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
    // The rate limit dependency raises a bare 429 with no error_code, so this
    // branches on the status rather than on a code that is not there.
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}

/**
 * Reads the callback outcome off a URL, or returns null.
 *
 * Pass `location.href` on the page the callback redirects to, which is whatever
 * `returnTo` named, or the product's frontend root when it named nothing.
 * Nothing here is fetched and nothing is decoded beyond the query string: the
 * session is already in the refresh cookie by the time this runs.
 *
 * The precedence when more than one parameter is present is fixed and worth
 * knowing: an error first, then an MFA ticket, then a link, then a sign-in. A
 * `return_to` that already carried a `?oauth=1` of its own would otherwise let
 * a stale parameter outrank a live refusal, and reporting a failed sign-in as a
 * successful one is the wrong way round to be wrong.
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
 * Removes every callback parameter from a URL, leaving the rest untouched.
 *
 * Feed the result to `history.replaceState` once the callback has been read.
 * Two reasons, and the first is the sharp one: an MFA ticket is a live bearer
 * value, and leaving it in the address bar leaves it in the browser history and
 * in the `Referer` of the next navigation off the page. The second is that a
 * reload would otherwise re-run the landing logic against a callback that was
 * already handled.
 *
 * Returns the input unchanged when it does not parse, so a caller can apply it
 * unconditionally.
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
  // The origin is dropped when the input was relative, so the output is
  // relative too and `replaceState` does not move the page to `localhost`.
  const relative =
    !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href) && !href.startsWith('//');
  const rebuilt = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return relative ? rebuilt : `${parsed.origin}${rebuilt}`;
}

/**
 * The message to show for a failed callback.
 *
 * A callback failure arrives as a code in a URL and nothing else: the server
 * cannot redirect a sentence, and it deliberately does not put a provider's own
 * `error_description` in the URL, so there is no server-written message to
 * prefer the way {@link describeAuthError} prefers one. These sentences are
 * therefore local, and they are the one place in this package where that is the
 * case.
 *
 * `OAUTH_CANCELLED` gets a deliberately flat sentence. The user pressed Cancel
 * on the consent screen, which is not an error and should not be rendered as
 * one.
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
 * Reads the `links` array off the list route's body.
 *
 * Every field is defended individually rather than trusting the shape, because
 * this crosses a repository boundary with nothing enforcing it at build time,
 * and a settings page rendering `undefined` for a date is worse than one
 * rendering an empty string.
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
    // A base, so a relative href such as '/settings?oauth=1' parses. The origin
    // is discarded: only the query is read.
    return new URL(href, 'http://localhost').searchParams;
  } catch {
    return null;
  }
}

/**
 * Narrows a raw callback code to the modelled set.
 *
 * `AUTH_ERROR_CODES` names every code the OAuth callback can redirect with, so
 * this is `isAuthErrorCode` and nothing more. It exists as a named function so
 * the reason the narrowing is safe has somewhere to live: a code from a future
 * server that this version does not name falls through to `rawCode` with
 * `code: undefined`, which is the same contract `getAuthErrorCode` has
 * everywhere else, and it is why {@link describeOAuthCallbackError} switches on
 * `rawCode` rather than on `code`.
 */
function isKnownOAuthCode(value: string): value is AuthErrorCode {
  return isAuthErrorCode(value);
}
