/**
 * The auth client of section 7.1 of the identity standard.
 *
 * The access token lives in one instance-scoped field and nowhere else. Not
 * `localStorage`, not `sessionStorage`, not a cookie the page can read. A page
 * reload loses it, which is correct, and the silent refresh on startup is what
 * repairs it: the refresh token is in an httpOnly cookie the browser attaches
 * to `/api/auth/refresh`, so a valid cookie signs the user back in without a
 * login screen and an invalid one renders anonymous.
 *
 * The three invariants that are easy to get wrong, and are all tested:
 *
 * 1. **One in-flight refresh.** Concurrent callers share a promise. Ten
 *    parallel 401s must produce one rotation, because ten rotations look like
 *    token reuse to the server, which revokes the family and signs the user out
 *    (2.6). The 10 second grace window on the server forgives what slips
 *    through; single flight stops it being the normal case.
 * 2. **Retry once, never recurse.** A 401 triggers one refresh and one replay.
 *    A second 401 ends the session. This lives in `@webbpulse/api-client`, which
 *    talks to this client through the narrow {@link AuthTokenProvider} contract
 *    so it keeps no dependency on this package.
 * 3. **`credentials: "include"` on every call.** Without it the refresh cookie
 *    is never attached cross origin, and every product serves its frontend and
 *    its API on different hosts under one registrable domain (5.5).
 */

import {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from '@webbpulse/api-client';

import {
  classifyLinkError,
  type EmailFlowPaths,
  type EmailRequestOutcome,
  type EmailVerificationOutcome,
  type PasswordResetOutcome,
} from './email-flows.js';
import { AuthSessionEndedError, getAuthErrorCode } from './errors.js';

/** Status of the session, as a single field. */
export type AuthStatus =
  /** No silent refresh has settled yet. Render nothing session dependent. */
  | 'unknown'
  /** A session call is in flight. */
  | 'loading'
  /** An access token is held. */
  | 'authenticated'
  /** No session. */
  | 'anonymous';

/** Immutable snapshot of the auth state. */
export interface AuthState<TUser> {
  status: AuthStatus;
  /** The signed in user, when the product supplied a `loadUser` hook. */
  user: TUser | null;
  /**
   * Whether an access token is currently held.
   *
   * Separate from `status` because a proactive refresh moves `status` to
   * `'loading'` while the old token is still valid and still being sent.
   */
  hasAccessToken: boolean;
  /** Last error from a session operation, cleared on the next success. */
  error: Error | null;
  /** Pending MFA challenge, when a login returned one. */
  pendingMfa: MfaChallenge | null;
}

/** What the server returns when a login needs a second factor. */
export interface MfaChallenge {
  /**
   * The short lived MFA ticket. `aud` is `<issuer>/mfa`, it lasts 5 minutes and
   * it is single use, so it is not an access token and buys nothing on its own.
   */
  ticket: string;
  /** The factors this account can satisfy, for example `['totp','webauthn']`. */
  factors: string[];
}

/** A successful login or MFA completion. */
export interface AuthSuccess<TUser> {
  mfaRequired: false;
  user: TUser | null;
  /** Seconds until the access token expires, as the server reported it. */
  expiresIn: number | undefined;
}

/** A login that stopped at the first leg because a second factor is needed. */
export interface AuthMfaRequired {
  mfaRequired: true;
  ticket: string;
  factors: string[];
}

/** What {@link AuthClient.login} resolves to. */
export type LoginOutcome<TUser> = AuthSuccess<TUser> | AuthMfaRequired;

/** Credentials for a password login. */
export interface PasswordCredentials {
  email: string;
  password: string;
  [key: string]: unknown;
}

/**
 * The token side of the client, as `@webbpulse/api-client` sees it.
 *
 * Deliberately narrow. api-client depends on this shape and not on this
 * package, so the dependency edge stays one way: auth depends on api-client,
 * never the reverse.
 */
export interface AuthTokenProvider {
  /** The access token held in memory, or null. Synchronous by design. */
  getAccessToken(): string | null;
  /**
   * Refreshes and resolves the new access token, or null when the session is
   * gone. Concurrent callers must share one in-flight request.
   */
  refresh(): Promise<string | null>;
}

/**
 * The WebAuthn surface this client uses.
 *
 * Typed structurally rather than against the DOM `CredentialsContainer`, so the
 * package type checks in a Node test run with no `navigator` and a test can
 * supply a stub without constructing a real credential.
 */
export interface WebAuthnAdapter {
  /** Wraps `navigator.credentials.create`, returning a serialisable payload. */
  create(options: unknown): Promise<unknown>;
  /** Wraps `navigator.credentials.get`, returning a serialisable payload. */
  get(options: unknown): Promise<unknown>;
}

/** Where the identity routes live, relative to the base URL. */
export interface AuthPaths extends EmailFlowPaths {
  /** Defaults to `/api/auth/login`. */
  login?: string;
  /** Defaults to `/api/auth/login/totp`. */
  totp?: string;
  /** Defaults to `/api/auth/refresh`. */
  refresh?: string;
  /** Defaults to `/api/auth/logout`. */
  logout?: string;
  /** Defaults to `/api/auth/logout-all`. */
  logoutAll?: string;
  /** Defaults to `/api/auth/register`. */
  register?: string;
  /** Defaults to `/api/auth/webauthn/register/options`. */
  passkeyRegisterOptions?: string;
  /** Defaults to `/api/auth/webauthn/register/verify`. */
  passkeyRegisterVerify?: string;
  /** Defaults to `/api/auth/login/webauthn/options`. */
  passkeyLoginOptions?: string;
  /** Defaults to `/api/auth/login/webauthn/verify`. */
  passkeyLoginVerify?: string;
  /** Defaults to `/api/auth/oauth`. A provider and `/start` are appended. */
  oauthStart?: string;
}

const DEFAULT_PATHS: Required<AuthPaths> = {
  login: '/api/auth/login',
  totp: '/api/auth/login/totp',
  refresh: '/api/auth/refresh',
  logout: '/api/auth/logout',
  logoutAll: '/api/auth/logout-all',
  register: '/api/auth/register',
  passkeyRegisterOptions: '/api/auth/webauthn/register/options',
  passkeyRegisterVerify: '/api/auth/webauthn/register/verify',
  passkeyLoginOptions: '/api/auth/login/webauthn/options',
  passkeyLoginVerify: '/api/auth/login/webauthn/verify',
  oauthStart: '/api/auth/oauth',
  verifyEmail: '/api/auth/verify-email',
  verifyEmailConfirm: '/api/auth/verify-email/confirm',
  passwordReset: '/api/auth/reset',
  passwordResetConfirm: '/api/auth/reset/confirm',
};

/** Construction options. */
export interface AuthClientOptions<TUser = unknown> {
  /**
   * Origin of the API. Ignored when `client` is supplied.
   *
   * One of `baseUrl` and `client` is required.
   */
  baseUrl?: string;
  /**
   * An existing client to make identity calls through.
   *
   * Supply this to share one retry policy, one request id factory and one
   * fetch implementation with the rest of the application. Never give it a
   * `getAuthToken` pointing back at this client: the identity routes that need
   * a bearer token get one from this client directly, and the ones that do not
   * must be callable with an expired token (2.3).
   */
  client?: ApiClient;
  /** Route overrides, when a product mounts identity somewhere else. */
  paths?: AuthPaths;
  /**
   * Loads the signed in user after a login or a successful refresh.
   *
   * Optional, because the standard does not put a user in the token response
   * and not every product needs one in state. When omitted, `state.user` stays
   * null and `status` still tracks the token.
   */
  loadUser?: (client: ApiClient) => Promise<TUser | null>;
  /**
   * Called once each time the session ends: a refresh that failed, or a logout.
   *
   * This is the navigation hook from 7.1, `onSessionEnded: () => router.navigate('/login')`.
   * It does not fire on a startup refresh that simply found no cookie, because
   * a first time visitor was never in a session and bouncing them to a login
   * screen they did not ask for is wrong. Read `status === 'anonymous'` for
   * that case.
   */
  onSessionEnded?: (error: AuthSessionEndedError) => void;
  /**
   * Fraction of `expires_in` at which the proactive refresh timer fires.
   * Defaults to 0.8, which is the figure in 7.1.
   */
  proactiveRefreshRatio?: number;
  /**
   * Turns the proactive refresh timer off. Defaults to false.
   *
   * Worth setting in a test or in server side rendering, where a dangling
   * timer keeps a process alive.
   */
  disableProactiveRefresh?: boolean;
  /** WebAuthn adapter. Defaults to `navigator.credentials` when present. */
  webAuthn?: WebAuthnAdapter;
  /** Options merged into the client this constructs from `baseUrl`. */
  clientOptions?: Omit<ApiClientOptions, 'baseUrl' | 'getAuthToken'>;
  /** Injected for tests. Defaults to `globalThis.setTimeout`. */
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
  /** Injected for tests. Defaults to `globalThis.clearTimeout`. */
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Full page navigation for the OAuth redirect. Defaults to `location.assign`. */
  navigate?: (url: string) => void;
}

/** Shape of a token response, as the identity service writes it. */
interface TokenResponseBody {
  access_token?: unknown;
  expires_in?: unknown;
  mfa_required?: unknown;
  mfa_ticket?: unknown;
  factors?: unknown;
  user?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/**
 * Which refusals each link route models, per route.
 *
 * Explicit sets rather than one permissive classifier, so a code that is a
 * legitimate outcome on one route cannot become a silent success on another. A
 * `PASSWORD_TOO_SHORT` arriving from the verification confirm route is a server
 * bug, and the right response to it is to throw rather than to invent a state
 * the caller can render.
 */
const EMAIL_REQUEST_REASONS: ReadonlySet<'rate-limited' | 'unavailable'> =
  new Set(['rate-limited', 'unavailable'] as const);

const CONFIRM_LINK_REASONS: ReadonlySet<
  'invalid-link' | 'rate-limited' | 'unavailable'
> = new Set(['invalid-link', 'rate-limited', 'unavailable'] as const);

const RESET_CONFIRM_REASONS: ReadonlySet<
  'invalid-link' | 'rate-limited' | 'unavailable' | 'password-rejected'
> = new Set([
  'invalid-link',
  'rate-limited',
  'unavailable',
  'password-rejected',
] as const);

/**
 * The auth client.
 *
 * ```ts
 * const auth = createAuthClient({
 *   baseUrl: 'https://api.carmodpicker.com',
 *   onSessionEnded: () => router.navigate('/login'),
 * });
 *
 * await auth.initialize();          // silent refresh on load
 * await auth.login({ email, password });
 * auth.getAccessToken();            // in memory, may be null
 * ```
 */
export class AuthClient<TUser = unknown> implements AuthTokenProvider {
  /**
   * The access token. The one place it exists.
   *
   * `private` is a compile time guard rather than a runtime one, but the point
   * is not to defend against a determined caller in the same realm: it is that
   * there is exactly one copy and it dies with the tab. Nothing in this class
   * writes it anywhere a script can read back after a reload.
   */
  private accessToken: string | null = null;

  private readonly client: ApiClient;
  private readonly options: AuthClientOptions<TUser>;
  private readonly paths: Required<AuthPaths>;
  private readonly listeners = new Set<(state: AuthState<TUser>) => void>();

  /** The single in-flight refresh. Null when no refresh is running. */
  private refreshInFlight: Promise<string | null> | null = null;
  /** The single in-flight startup refresh, so `initialize` is idempotent. */
  private initializePromise: Promise<TUser | null> | null = null;
  private proactiveTimer: unknown = null;
  private disposed = false;

  private state: AuthState<TUser> = {
    status: 'unknown',
    user: null,
    hasAccessToken: false,
    error: null,
    pendingMfa: null,
  };

  constructor(options: AuthClientOptions<TUser>) {
    this.options = options;
    this.paths = { ...DEFAULT_PATHS, ...options.paths };

    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      if (options.baseUrl === undefined || options.baseUrl === '') {
        throw new Error(
          'createAuthClient requires either baseUrl or an existing client.'
        );
      }
      this.client = createApiClient({
        ...options.clientOptions,
        baseUrl: options.baseUrl,
        // Every request sends the cookie. Without this the refresh cookie is
        // never attached cross origin and silent refresh cannot work at all.
        credentials: options.clientOptions?.credentials ?? 'include',
      });
    }
  }

  // ---------------------------------------------------------------- state

  /** Current snapshot. Stable by reference until something changes. */
  getState(): AuthState<TUser> {
    return this.state;
  }

  /**
   * The access token held in memory, or null.
   *
   * Synchronous, which is what lets `@webbpulse/api-client` read it on the hot
   * path without awaiting on every request.
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Subscribes to state changes. Returns the unsubscribe function. */
  subscribe(listener: (state: AuthState<TUser>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<AuthState<TUser>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }

  /**
   * Adopts a new access token and arms the proactive refresh.
   *
   * The only writer of `this.accessToken` other than the clear path, so the
   * timer and the state can never disagree with the token about whether a
   * session exists.
   */
  private adoptToken(token: string, expiresIn: number | undefined): void {
    this.accessToken = token;
    this.scheduleProactiveRefresh(expiresIn);
  }

  /**
   * Drops the token and everything derived from it.
   *
   * Called on logout and on a refresh that failed. It never clears the cookie
   * itself, because the cookie is httpOnly and only the server can: a logout
   * that could not reach the server leaves the cookie in place, and the next
   * silent refresh either revives the session or gets a 401 and ends here
   * again. Either outcome is correct; leaving stale state in memory is not.
   */
  private clearToken(): void {
    this.accessToken = null;
    this.cancelProactiveRefresh();
  }

  // -------------------------------------------------------------- timers

  private scheduleProactiveRefresh(expiresIn: number | undefined): void {
    this.cancelProactiveRefresh();
    if (
      this.options.disableProactiveRefresh === true ||
      this.disposed ||
      expiresIn === undefined ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      return;
    }
    const ratio = this.options.proactiveRefreshRatio ?? 0.8;
    const delayMs = Math.max(1, Math.floor(expiresIn * ratio * 1000));
    const setTimeoutImpl =
      this.options.setTimeoutImpl ??
      ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
    this.proactiveTimer = setTimeoutImpl(() => {
      this.proactiveTimer = null;
      // A proactive refresh that fails is not an error the user asked for, so
      // it is swallowed here. `refresh` has already cleared the session and
      // notified `onSessionEnded` by the time this rejection arrives.
      void this.refresh().catch(() => undefined);
    }, delayMs);
  }

  private cancelProactiveRefresh(): void {
    if (this.proactiveTimer === null) {
      return;
    }
    const clearTimeoutImpl =
      this.options.clearTimeoutImpl ??
      ((handle: unknown) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimeoutImpl(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  /**
   * Releases the proactive refresh timer and drops every subscriber.
   *
   * Call it when the application tears down. A live timer holds a Node process
   * open and keeps a torn down single page application refreshing a session
   * nothing is watching.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelProactiveRefresh();
    this.listeners.clear();
  }

  // ------------------------------------------------------------- startup

  /**
   * The silent refresh on load, from 7.1.
   *
   * Calls the refresh endpoint once with credentials. A valid cookie signs the
   * user in with no login screen; anything else renders anonymous. It resolves
   * rather than rejecting on a missing session, because "nobody is signed in"
   * is an expected answer at startup and not a failure the caller must catch.
   *
   * Idempotent: concurrent calls, which React StrictMode's double mount
   * produces on every dev render, share one request.
   */
  async initialize(): Promise<TUser | null> {
    if (this.initializePromise !== null) {
      return this.initializePromise;
    }
    const run = async (): Promise<TUser | null> => {
      this.setState({ status: 'loading', error: null });
      try {
        const token = await this.performRefresh({ startup: true });
        if (token === null) {
          return null;
        }
        return await this.settleAuthenticated(undefined);
      } catch {
        // performRefresh has already set the anonymous state. A startup
        // refresh with no cookie is the normal first visit, not an error.
        return null;
      } finally {
        this.initializePromise = null;
      }
    };
    this.initializePromise = run();
    return this.initializePromise;
  }

  // ------------------------------------------------------------- refresh

  /**
   * Refreshes the access token, sharing one in-flight request.
   *
   * This is the single-flight of 7.1. The promise is stored before it is
   * awaited, so a caller arriving during the request joins it rather than
   * starting a second rotation. It is cleared in a `finally`, so the next
   * caller after it settles starts a fresh one.
   *
   * Resolves to the new token, or to null when the session is gone. It does not
   * reject on a refused refresh: every caller of this treats "no session" as an
   * outcome, and the rejection would otherwise have to be caught in three
   * places that all do the same thing.
   */
  async refresh(): Promise<string | null> {
    if (this.refreshInFlight !== null) {
      return this.refreshInFlight;
    }
    const run = async (): Promise<string | null> => {
      try {
        return await this.performRefresh({ startup: false });
      } catch {
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    };
    this.refreshInFlight = run();
    return this.refreshInFlight;
  }

  /**
   * One actual call to the refresh endpoint.
   *
   * Separate from `refresh` so `initialize` can distinguish a startup refresh,
   * which must not fire `onSessionEnded`, from a mid session one, which must.
   */
  private async performRefresh(opts: {
    startup: boolean;
  }): Promise<string | null> {
    try {
      const response = await this.client.post<TokenResponseBody>(
        this.paths.refresh,
        undefined,
        // A refresh must not retry. The server rotates the token on the first
        // attempt, so a retry presents a consumed token and looks like reuse.
        { retries: 0 }
      );
      const token = response.data.access_token;
      if (typeof token !== 'string' || token === '') {
        throw new AuthSessionEndedError({
          message: 'The refresh response carried no access token.',
          reason: 'refresh-failed',
        });
      }
      const expiresIn =
        typeof response.data.expires_in === 'number'
          ? response.data.expires_in
          : undefined;
      this.adoptToken(token, expiresIn);
      return token;
    } catch (error) {
      const code = getAuthErrorCode(error);
      const ended = new AuthSessionEndedError({
        message:
          error instanceof Error
            ? error.message
            : 'The session could not be refreshed.',
        code,
        reason: opts.startup ? 'no-session' : 'refresh-failed',
        cause: error,
      });
      this.endSession(ended, {
        // A startup refresh that finds no cookie is a first time visitor, not a
        // session that ended, so it must not bounce them to a login screen.
        notify: !opts.startup,
        // A refused refresh is an expected outcome and not worth surfacing as a
        // page level error. A 500 from the refresh endpoint is worth keeping.
        recordError: !(error instanceof ApiError && error.isUnauthorized),
      });
      throw ended;
    }
  }

  /** Clears the session and, unless suppressed, notifies `onSessionEnded`. */
  private endSession(
    error: AuthSessionEndedError,
    opts: { notify: boolean; recordError: boolean }
  ): void {
    this.clearToken();
    this.setState({
      status: 'anonymous',
      user: null,
      hasAccessToken: false,
      error: opts.recordError ? error : null,
      pendingMfa: null,
    });
    if (opts.notify) {
      this.options.onSessionEnded?.(error);
    }
  }

  // --------------------------------------------------------------- login

  /**
   * Signs in with a password.
   *
   * Resolves to `{ mfaRequired: true, ticket, factors }` when the account needs
   * a second factor, which is a successful outcome and not an error: the first
   * leg returns no access token by design (2.6). Call `completeTotp` or
   * `completePasskeyMfa` with the ticket to finish. A failed login rejects, so
   * the form that triggered it can render the reason.
   */
  async login(credentials: PasswordCredentials): Promise<LoginOutcome<TUser>> {
    return this.runTokenCall(this.paths.login, credentials);
  }

  /** Registers an account. Returns whatever the register route answers. */
  async register(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.client.post<unknown>(this.paths.register, body);
    return response.data;
  }

  /** Completes an MFA login with a TOTP code. */
  async completeTotp(input: {
    ticket: string;
    code: string;
  }): Promise<LoginOutcome<TUser>> {
    return this.runTokenCall(this.paths.totp, {
      mfa_ticket: input.ticket,
      code: input.code,
    });
  }

  /**
   * Passwordless passkey login, with discoverable credentials.
   *
   * Two legs: fetch the options, then hand the authenticator's assertion back.
   * The `allowCredentials` list is empty on the server side, so the
   * authenticator offers whatever it holds for the relying party.
   */
  async loginWithPasskey(): Promise<LoginOutcome<TUser>> {
    const webAuthn = this.requireWebAuthn();
    const options = await this.client.post<unknown>(
      this.paths.passkeyLoginOptions,
      {}
    );
    const assertion = await webAuthn.get(options.data);
    return this.runTokenCall(this.paths.passkeyLoginVerify, { assertion });
  }

  /**
   * Completes an MFA login with a passkey.
   *
   * A passkey with user verification is two factors in one gesture and
   * satisfies the requirement on its own, so this is also the step up path when
   * the first leg listed `webauthn` among its factors.
   */
  async completePasskeyMfa(input: {
    ticket: string;
  }): Promise<LoginOutcome<TUser>> {
    const webAuthn = this.requireWebAuthn();
    const options = await this.client.post<unknown>(
      this.paths.passkeyLoginOptions,
      { mfa_ticket: input.ticket }
    );
    const assertion = await webAuthn.get(options.data);
    return this.runTokenCall(this.paths.passkeyLoginVerify, {
      mfa_ticket: input.ticket,
      assertion,
    });
  }

  /**
   * Adds a passkey to the signed in account. Requires a session.
   *
   * Both legs are authorized routes, so they carry the bearer token, which is
   * why this rejects rather than prompting when no session is held.
   */
  async registerPasskey(): Promise<unknown> {
    const webAuthn = this.requireWebAuthn();
    if (this.accessToken === null) {
      throw new AuthSessionEndedError({
        message: 'registerPasskey requires a signed in session.',
        reason: 'no-session',
      });
    }
    const options = await this.client.post<unknown>(
      this.paths.passkeyRegisterOptions,
      {},
      { headers: this.authorizationHeader() }
    );
    const attestation = await webAuthn.create(options.data);
    const verified = await this.client.post<unknown>(
      this.paths.passkeyRegisterVerify,
      { attestation },
      { headers: this.authorizationHeader() }
    );
    return verified.data;
  }

  /**
   * Starts an OAuth login or link with a full page redirect.
   *
   * Synchronous and returning void, because the page is leaving: there is no
   * promise for the caller to await and nothing to resolve on the other side.
   * `mode` distinguishes a login from a link performed by an already signed in
   * user, which is what stops a callback being replayed into the other meaning.
   */
  startOAuth(
    provider: string,
    options: { returnTo?: string; mode?: 'login' | 'link' } = {}
  ): void {
    const query = new URLSearchParams();
    if (options.returnTo !== undefined) {
      query.set('return_to', options.returnTo);
    }
    if (options.mode !== undefined) {
      query.set('mode', options.mode);
    }
    const suffix = query.toString();
    const base = this.client.baseUrl;
    const path = `${this.paths.oauthStart}/${encodeURIComponent(provider)}/start`;
    const url = `${base}${path}${suffix === '' ? '' : `?${suffix}`}`;
    const navigate =
      this.options.navigate ??
      ((target: string) => {
        globalThis.location.assign(target);
      });
    navigate(url);
  }

  /**
   * Signs out.
   *
   * Calls the backend, which revokes the whole refresh family rather than the
   * single token and clears the cookie, then clears memory. The memory clear
   * happens whether or not the call succeeded: a network failure must not
   * strand the user in a session the UI still believes in. It fires
   * `onSessionEnded` exactly once, with reason `'logged-out'`.
   */
  async logout(options: { everywhere?: boolean } = {}): Promise<void> {
    const path =
      options.everywhere === true ? this.paths.logoutAll : this.paths.logout;
    const headers = this.authorizationHeader();
    this.setState({ status: 'loading', error: null });
    try {
      await this.client.post(path, undefined, { retries: 0, headers });
    } catch {
      // Deliberately swallowed. The local session ends regardless, and the
      // cookie is either already gone or will be refused on its next use.
    } finally {
      this.endSession(
        new AuthSessionEndedError({
          message: 'Signed out.',
          reason: 'logged-out',
        }),
        { notify: true, recordError: false }
      );
    }
  }

  // -------------------------------------------------- email link flows

  /**
   * Asks the backend to mail a verification link.
   *
   * Anonymous and keyed by address, matching the route: a user who never
   * finished signing up has no session to authenticate with, and the resend has
   * to work for exactly that person. It does not read `state.user`, so it works
   * on a signed out page.
   *
   * **Resolves the same way whatever the address is.** Section 5.4 puts this in
   * the enumeration-resistance table, so an unknown address, an address that is
   * already verified and an address that just got a link all answer 200 with
   * the same body. There is deliberately nothing here to tell them apart, and a
   * caller must not try: render "if that address needs verifying, a link is on
   * its way" and nothing more specific.
   *
   * Returns `ok: false` only for a rate limit or an identity deployment with no
   * sender. It rejects for a network failure or a 500.
   */
  async requestEmailVerification(input: {
    email: string;
  }): Promise<EmailRequestOutcome> {
    return this.runEmailRequest(this.paths.verifyEmail, input.email);
  }

  /**
   * Confirms a verification link and marks the address verified.
   *
   * Anonymous, and a POST: the link in the email lands on
   * {@link VERIFY_EMAIL_PATH} in the SPA, which reads the token with
   * {@link readLinkToken} and calls this. The backend deliberately does not
   * confirm on a `GET`, because a mail scanner following the link to check it
   * for malware would spend the token before the user ever clicked.
   *
   * Returns `ok: false, reason: 'invalid-link'` for a token that is unknown,
   * expired, already spent, or a reset token presented here by mistake. Those
   * four are one outcome with one message on purpose: the difference between
   * them is information about somebody else's token.
   */
  async confirmEmailVerification(input: {
    token: string;
  }): Promise<EmailVerificationOutcome> {
    try {
      const response = await this.client.post<{ user_id?: unknown }>(
        this.paths.verifyEmailConfirm,
        { token: input.token },
        // No retry. The token is single use, so a retried request presents a
        // token the first attempt already spent and is refused as invalid.
        { retries: 0 }
      );
      const userId = response.data.user_id;
      return { ok: true, userId: typeof userId === 'string' ? userId : null };
    } catch (error) {
      const refused = classifyLinkError(error, CONFIRM_LINK_REASONS);
      if (refused === null) {
        throw error;
      }
      return refused;
    }
  }

  /**
   * Asks the backend to mail a password reset link.
   *
   * Like {@link requestEmailVerification}, this answers identically whether or
   * not the address has an account, and section 5.4 fixes the wording the
   * server returns in `detail`: "If that address has an account, a link is on
   * its way." Render that rather than a local sentence, so one carefully
   * phrased line is the only thing users ever see here.
   */
  async requestPasswordReset(input: {
    email: string;
  }): Promise<EmailRequestOutcome> {
    return this.runEmailRequest(this.paths.passwordReset, input.email);
  }

  /**
   * Spends a reset link and sets a new password.
   *
   * On success **every session for that account is gone**, this browser's
   * included: a reset is the remedy for a compromise, so the backend revokes
   * every refresh family and clears the refresh cookie. This client therefore
   * drops its own token too, rather than holding one the server will refuse on
   * its next use. The user signs in again with the new password, which is the
   * intended end of the flow.
   *
   * Three distinct refusals, because the remedies differ: `invalid-link` means
   * ask for a new link, `password-rejected` means the link is spent *and* the
   * password was no good so ask for a new link and choose another, and
   * `rate-limited` means wait.
   *
   * `familyIds` is the exact-revocation seam the backend's `logout_all` uses.
   * Almost no caller has it, and omitting it is the normal case.
   */
  async confirmPasswordReset(input: {
    token: string;
    newPassword: string;
    familyIds?: string[];
  }): Promise<PasswordResetOutcome> {
    const body: Record<string, unknown> = {
      token: input.token,
      // Snake case, because that is what the route reads off the body.
      new_password: input.newPassword,
    };
    if (input.familyIds !== undefined) {
      body['family_ids'] = input.familyIds;
    }
    try {
      await this.client.post(this.paths.passwordResetConfirm, body, {
        retries: 0,
      });
      // The reset revoked every family, so any token held here is dead. Ending
      // the session locally keeps memory honest about that. `notify` is false:
      // the caller is standing on the reset page and is about to be sent to the
      // sign in form by its own success branch, so firing `onSessionEnded` here
      // would be a second, competing navigation.
      this.endSession(
        new AuthSessionEndedError({
          message: 'The password was reset and every session was ended.',
          reason: 'logged-out',
        }),
        { notify: false, recordError: false }
      );
      return { ok: true };
    } catch (error) {
      const refused = classifyLinkError(error, RESET_CONFIRM_REASONS);
      if (refused === null) {
        throw error;
      }
      return refused;
    }
  }

  /**
   * The shared body of the two request routes.
   *
   * Written once because the two are the same shape by design, and because the
   * property that matters here is a negative one: neither of them may leak
   * whether the address exists. One implementation is one place to check that.
   */
  private async runEmailRequest(
    path: string,
    email: string
  ): Promise<EmailRequestOutcome> {
    try {
      const response = await this.client.post<{ detail?: unknown }>(
        path,
        { email },
        // No retry. A retry spends a second slot in a bucket the standard sets
        // at three per hour per address, and mails a second link for one ask.
        { retries: 0 }
      );
      const detail = response.data.detail;
      return {
        ok: true,
        detail: typeof detail === 'string' ? detail : undefined,
      };
    } catch (error) {
      const refused = classifyLinkError(error, EMAIL_REQUEST_REASONS);
      if (refused === null) {
        throw error;
      }
      return refused;
    }
  }

  // ------------------------------------------------------------- helpers

  private authorizationHeader(): Record<string, string> {
    return this.accessToken === null
      ? {}
      : { authorization: `Bearer ${this.accessToken}` };
  }

  private requireWebAuthn(): WebAuthnAdapter {
    if (this.options.webAuthn !== undefined) {
      return this.options.webAuthn;
    }
    const credentials = (
      globalThis as { navigator?: { credentials?: unknown } }
    ).navigator?.credentials as
      | {
          create(options: unknown): Promise<unknown>;
          get(options: unknown): Promise<unknown>;
        }
      | undefined;
    if (credentials === undefined) {
      throw new Error(
        'WebAuthn is not available in this environment. Pass a webAuthn adapter to createAuthClient.'
      );
    }
    return {
      create: (options: unknown) => credentials.create({ publicKey: options }),
      get: (options: unknown) => credentials.get({ publicKey: options }),
    };
  }

  /**
   * Posts to a route that answers with a token, an MFA challenge, or an error.
   *
   * Shared by every login shaped call, so the MFA branch, the token adoption
   * and the error handling are written once. None of these routes retries: they
   * are POSTs the client already refuses to retry, and a duplicate login attempt
   * would burn a rate limit bucket for no gain.
   */
  private async runTokenCall(
    path: string,
    body: unknown
  ): Promise<LoginOutcome<TUser>> {
    this.setState({ status: 'loading', error: null, pendingMfa: null });
    try {
      const response = await this.client.post<TokenResponseBody>(path, body, {
        retries: 0,
      });
      const data = response.data;

      if (data.mfa_required === true) {
        const ticket =
          typeof data.mfa_ticket === 'string' ? data.mfa_ticket : '';
        const factors = asStringArray(data.factors);
        const challenge: MfaChallenge = { ticket, factors };
        this.setState({
          status: 'anonymous',
          user: null,
          hasAccessToken: false,
          error: null,
          pendingMfa: challenge,
        });
        return { mfaRequired: true, ticket, factors };
      }

      const token = data.access_token;
      if (typeof token !== 'string' || token === '') {
        throw new AuthSessionEndedError({
          message:
            'The login response carried neither a token nor a challenge.',
          reason: 'refresh-failed',
        });
      }
      const expiresIn =
        typeof data.expires_in === 'number' ? data.expires_in : undefined;
      this.adoptToken(token, expiresIn);
      const user = await this.settleAuthenticated(
        data.user as TUser | undefined
      );
      return { mfaRequired: false, user, expiresIn };
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      this.setState({
        status: this.accessToken === null ? 'anonymous' : 'authenticated',
        hasAccessToken: this.accessToken !== null,
        error: asError,
      });
      throw asError;
    }
  }

  /**
   * Moves to the authenticated state, loading the user when a hook was given.
   *
   * A `loadUser` that throws does not undo the session: the token is valid, the
   * user endpoint is a separate concern, and signing someone out because their
   * profile failed to load would be a worse outcome than a null user.
   */
  private async settleAuthenticated(
    embeddedUser: TUser | undefined
  ): Promise<TUser | null> {
    let user: TUser | null =
      embeddedUser === undefined || embeddedUser === null ? null : embeddedUser;
    let loadError: Error | null = null;
    if (user === null && this.options.loadUser !== undefined) {
      try {
        user = await this.options.loadUser(this.client);
      } catch (error) {
        loadError = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.setState({
      status: 'authenticated',
      user,
      hasAccessToken: this.accessToken !== null,
      error: loadError,
      pendingMfa: null,
    });
    return user;
  }
}

/** Constructs an {@link AuthClient}. */
export function createAuthClient<TUser = unknown>(
  options: AuthClientOptions<TUser>
): AuthClient<TUser> {
  return new AuthClient<TUser>(options);
}
