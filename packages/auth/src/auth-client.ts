/**
 * The auth client of section 7.1 of the identity standard. The access token
 * lives in one instance-scoped field and nowhere a script can read back after a
 * reload; the httpOnly refresh cookie repairs it on startup. Three invariants
 * hold: one in-flight refresh, one retry per 401 with no recursion, and
 * `credentials: 'include'` on every call.
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
import {
  classifyOAuthError,
  parseOAuthLinks,
  type OAuthLinkOutcome,
  type OAuthLinksOutcome,
  type OAuthPaths,
  type OAuthRefusal,
  type OAuthStartOptions,
  type OAuthUnlinkOutcome,
} from './oauth.js';
import {
  classifyMfaError,
  type MfaPaths,
  type MfaRefusal,
  type RecoveryCodesOutcome,
  type StepUpOutcome,
  type TotpActivationOutcome,
  type TotpDisableOutcome,
  type TotpEnrolmentOutcome,
} from './mfa.js';
import {
  classifyPasskeyError,
  credentialToJSON,
  parsePasskey,
  parsePasskeyChallenge,
  parsePasskeys,
  toCreationOptions,
  toRequestOptions,
  type PasskeyChallenge,
  type PasskeyDeleteOutcome,
  type PasskeyListOutcome,
  type PasskeyPaths,
  type PasskeyRefusal,
  type PasskeyRegistrationOutcome,
  type PasskeyRenameOutcome,
  type PasskeySignInOutcome,
  type WebAuthnAdapter,
} from './passkeys.js';

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
   * Whether an access token is currently held. Separate from `status`, which a
   * proactive refresh moves to `'loading'` while the old token is still valid.
   */
  hasAccessToken: boolean;
  /** Last error from a session operation, cleared on the next success. */
  error: Error | null;
  /**
   * The ending of the session, whatever the status code that ended it, cleared
   * by the next successful `login` or `initialize`. Distinct from `error`, which
   * stays silent on an ordinary 401 expiry, so this is the field to read as
   * "the session ended".
   */
  sessionEnded: AuthSessionEndedError | null;
  /** Pending MFA challenge, when a login returned one. */
  pendingMfa: MfaChallenge | null;
}

/** What the server returns when a login needs a second factor. */
export interface MfaChallenge {
  /**
   * The short lived MFA ticket. Audience-scoped, single use and five minutes
   * long, so it is not an access token and buys nothing on its own.
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
 * Deliberately narrow, so the dependency edge stays one way: auth depends on
 * api-client, never the reverse.
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

export type { WebAuthnAdapter } from './passkeys.js';

/** Where the identity routes live, relative to the base URL. */
export interface AuthPaths
  extends EmailFlowPaths, MfaPaths, OAuthPaths, PasskeyPaths {
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
}

const DEFAULT_PATHS: Required<AuthPaths> = {
  login: '/api/auth/login',
  totp: '/api/auth/login/totp',
  refresh: '/api/auth/refresh',
  logout: '/api/auth/logout',
  logoutAll: '/api/auth/logout-all',
  register: '/api/auth/register',
  passkeyRegisterOptions: '/api/auth/passkeys/register/options',
  passkeyRegisterVerify: '/api/auth/passkeys/register/verify',
  passkeyLoginOptions: '/api/auth/login/passkey/options',
  passkeyLoginVerify: '/api/auth/login/passkey/verify',
  passkeys: '/api/auth/passkeys',
  oauthStart: '/api/auth/oauth',
  oauthLinks: '/api/auth/oauth/links',
  verifyEmail: '/api/auth/verify-email',
  verifyEmailConfirm: '/api/auth/verify-email/confirm',
  passwordReset: '/api/auth/reset',
  passwordResetConfirm: '/api/auth/reset/confirm',
  totpEnrol: '/api/auth/totp/enrol',
  totpActivate: '/api/auth/totp/activate',
  totpDisable: '/api/auth/totp/disable',
  recoveryCodes: '/api/auth/recovery-codes',
  stepUp: '/api/auth/step-up',
};

/** Construction options. */
export interface AuthClientOptions<TUser = unknown> {
  /**
   * Origin of the API, ignored when `client` is supplied. One of `baseUrl` and
   * `client` is required.
   */
  baseUrl?: string;
  /**
   * An existing client to make identity calls through, to share one retry
   * policy and fetch implementation with the rest of the application. Never give
   * it a `getAuthToken` pointing back at this client.
   */
  client?: ApiClient;
  /** Route overrides, when a product mounts identity somewhere else. */
  paths?: AuthPaths;
  /**
   * Loads the signed in user after a login or a successful refresh. Optional:
   * when omitted, `state.user` stays null and `status` still tracks the token.
   */
  loadUser?: (client: ApiClient) => Promise<TUser | null>;
  /**
   * Called once each time the session ends, whether by a failed refresh or a
   * logout. It does not fire on a startup refresh that found no cookie; read
   * `status === 'anonymous'` for that. React code reaches the same ending
   * through `state.sessionEnded` rather than this constructor hook.
   */
  onSessionEnded?: (error: AuthSessionEndedError) => void;
  /**
   * Fraction of `expires_in` at which the proactive refresh timer fires.
   * Defaults to 0.8.
   */
  proactiveRefreshRatio?: number;
  /**
   * Turns the proactive refresh timer off. Defaults to false, and worth setting
   * in a test or in server side rendering where a dangling timer holds a process
   * open.
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
 * Which refusals each link route models. Explicit sets rather than one
 * permissive classifier, so a code that is a legitimate outcome on one route
 * cannot become a silent success on another.
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
 * Which refusals each MFA route models, on the same rule the link routes follow.
 * `invalid-code` appears on every route that presents a code, which is all of
 * them except enrol.
 */
const ENROL_REASONS: ReadonlySet<
  'already-enabled' | 'rate-limited' | 'unavailable'
> = new Set(['already-enabled', 'rate-limited', 'unavailable'] as const);

const ACTIVATE_REASONS: ReadonlySet<
  'invalid-code' | 'no-pending-enrolment' | 'rate-limited' | 'unavailable'
> = new Set([
  'invalid-code',
  'no-pending-enrolment',
  'rate-limited',
  'unavailable',
] as const);

const CODE_REASONS: ReadonlySet<
  'invalid-code' | 'rate-limited' | 'unavailable'
> = new Set(['invalid-code', 'rate-limited', 'unavailable'] as const);

/**
 * Which refusals each OAuth management route models, on the same rule again.
 * `rate-limited` is on the attach alone, since it is the only one of the three
 * that starts an authorization.
 */
const LINK_REASONS: ReadonlySet<
  'already-linked' | 'provider-unavailable' | 'rate-limited'
> = new Set([
  'already-linked',
  'provider-unavailable',
  'rate-limited',
] as const);

const LIST_REASONS: ReadonlySet<'provider-unavailable'> = new Set([
  'provider-unavailable',
] as const);

const UNLINK_REASONS: ReadonlySet<
  'last-sign-in-method' | 'not-linked' | 'provider-unavailable'
> = new Set([
  'last-sign-in-method',
  'not-linked',
  'provider-unavailable',
] as const);

/**
 * The refusals each passkey method models, on the same rule again. `cancelled`
 * and `rate-limited` are on the two ceremony methods alone, and `unavailable` on
 * all five, since a deployment with passkeys off refuses every route.
 */
const REGISTER_REASONS: ReadonlySet<
  | 'rejected'
  | 'already-registered'
  | 'unavailable'
  | 'rate-limited'
  | 'cancelled'
> = new Set([
  'rejected',
  'already-registered',
  'unavailable',
  'rate-limited',
  'cancelled',
] as const);

const SIGN_IN_REASONS: ReadonlySet<
  'rejected' | 'unavailable' | 'rate-limited' | 'cancelled'
> = new Set(['rejected', 'unavailable', 'rate-limited', 'cancelled'] as const);

const PASSKEY_LIST_REASONS: ReadonlySet<'unavailable'> = new Set([
  'unavailable',
] as const);

const RENAME_REASONS: ReadonlySet<
  'not-found' | 'name-required' | 'unavailable'
> = new Set(['not-found', 'name-required', 'unavailable'] as const);

const DELETE_REASONS: ReadonlySet<
  'not-found' | 'last-credential' | 'unavailable'
> = new Set(['not-found', 'last-credential', 'unavailable'] as const);

/**
 * WebAuthn creation options for the browser, preferring the browser's own
 * `parseCreationOptionsFromJSON`, which keeps pace with fields added after this
 * version. {@link toCreationOptions} is the fallback.
 */
function parseCreationOptions(json: Record<string, unknown>): unknown {
  const ctor = (
    globalThis as {
      PublicKeyCredential?: {
        parseCreationOptionsFromJSON?: (value: unknown) => unknown;
      };
    }
  ).PublicKeyCredential;
  if (typeof ctor?.parseCreationOptionsFromJSON === 'function') {
    return ctor.parseCreationOptionsFromJSON(json);
  }
  return toCreationOptions(json);
}

/** @see {@link parseCreationOptions} */
function parseRequestOptions(json: Record<string, unknown>): unknown {
  const ctor = (
    globalThis as {
      PublicKeyCredential?: {
        parseRequestOptionsFromJSON?: (value: unknown) => unknown;
      };
    }
  ).PublicKeyCredential;
  if (typeof ctor?.parseRequestOptionsFromJSON === 'function') {
    return ctor.parseRequestOptionsFromJSON(json);
  }
  return toRequestOptions(json);
}

/** The body the two routes that issue recovery codes answer with. */
interface RecoveryCodesBody {
  recovery_codes?: unknown;
}

/**
 * The auth client.
 *
 * ```ts
 * const auth = createAuthClient({
 *   baseUrl: 'https://api.carmodpicker.com',
 *   onSessionEnded: () => router.navigate('/login'),
 * });
 *
 * await auth.initialize();
 * await auth.login({ email, password });
 * auth.getAccessToken();
 * ```
 */
export class AuthClient<TUser = unknown> implements AuthTokenProvider {
  /**
   * The access token. The one place it exists: there is exactly one copy and it
   * dies with the tab.
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
    sessionEnded: null,
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
        credentials: options.clientOptions?.credentials ?? 'include',
      });
    }
  }

  /** Current snapshot. Stable by reference until something changes. */
  getState(): AuthState<TUser> {
    return this.state;
  }

  /**
   * The access token held in memory, or null. Synchronous, so
   * `@webbpulse/api-client` can read it on the hot path without awaiting.
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
   * Adopts a new access token and arms the proactive refresh. The only writer of
   * the token other than the clear path, so the timer and the state can never
   * disagree with it about whether a session exists.
   */
  private adoptToken(token: string, expiresIn: number | undefined): void {
    this.accessToken = token;
    this.scheduleProactiveRefresh(expiresIn);
  }

  /**
   * Drops the token and everything derived from it, on logout and on a failed
   * refresh. It never clears the cookie, which is httpOnly and the server's to
   * clear; the next silent refresh either revives the session or ends here
   * again.
   */
  private clearToken(): void {
    this.accessToken = null;
    this.cancelProactiveRefresh();
  }

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
   * Releases the proactive refresh timer and drops every subscriber. Call it on
   * teardown: a live timer holds a Node process open and keeps refreshing a
   * session nothing is watching.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelProactiveRefresh();
    this.listeners.clear();
  }

  /**
   * The silent refresh on load. A valid cookie signs the user in with no login
   * screen and anything else renders anonymous, resolving rather than rejecting
   * because no session is an expected answer at startup. Idempotent, so
   * StrictMode's double mount makes one request.
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
        return null;
      } finally {
        this.initializePromise = null;
      }
    };
    this.initializePromise = run();
    return this.initializePromise;
  }

  /**
   * Refreshes the access token, sharing one in-flight request: the promise is
   * stored before it is awaited, so a caller arriving mid-request joins it
   * rather than starting a second rotation. Resolves to null when the session is
   * gone rather than rejecting.
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
   * One actual call to the refresh endpoint. Separate from `refresh` so
   * `initialize` can distinguish a startup refresh, which must not fire
   * `onSessionEnded`, from a mid session one, which must.
   */
  private async performRefresh(opts: {
    startup: boolean;
  }): Promise<string | null> {
    try {
      const response = await this.client.post<TokenResponseBody>(
        this.paths.refresh,
        undefined,
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
        notify: !opts.startup,
        recordError: !(error instanceof ApiError && error.isUnauthorized),
        recordEnding: !opts.startup,
      });
      throw ended;
    }
  }

  /**
   * Clears the session and, unless suppressed, notifies `onSessionEnded` and
   * records the ending in `sessionEnded`. `recordEnding` is separate from
   * `recordError`, so an ordinary 401 expiry reaches a React subscriber while
   * leaving `error` null as it always has, and separate from `notify`, so a
   * password reset that ended every session elsewhere still shows up in state.
   */
  private endSession(
    error: AuthSessionEndedError,
    opts: { notify: boolean; recordError: boolean; recordEnding?: boolean }
  ): void {
    this.clearToken();
    this.setState({
      status: 'anonymous',
      user: null,
      hasAccessToken: false,
      error: opts.recordError ? error : null,
      sessionEnded: opts.recordEnding === false ? null : error,
      pendingMfa: null,
    });
    if (opts.notify) {
      this.options.onSessionEnded?.(error);
    }
  }

  /**
   * Signs in with a password. Resolves to `{ mfaRequired: true, ticket, factors }`
   * when the account needs a second factor, which is a successful outcome to
   * finish with `completeTotp`. A failed login rejects, so the form can render
   * the reason.
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
   * Enrols a new passkey on the signed-in account. Both legs are one method
   * because the challenge between them is single use and spent by one attempt,
   * so a failed ceremony starts again from the options leg. `name` is the
   * settings-page label, which the server trims, caps and defaults.
   *
   * @example
   * ```ts
   * const outcome = await auth.registerPasskey({ name: 'MacBook Touch ID' });
   * if (outcome.ok) {
   *   setPasskeys((current) => [...current, outcome.passkey]);
   * } else if (outcome.reason !== 'cancelled') {
   *   setBanner(outcome.message);
   * }
   * ```
   */
  async registerPasskey(
    input: { name?: string } = {}
  ): Promise<PasskeyRegistrationOutcome> {
    if (this.accessToken === null) {
      throw new AuthSessionEndedError({
        message: 'registerPasskey requires a signed in session.',
        reason: 'no-session',
      });
    }
    try {
      const webAuthn = this.requireWebAuthn();
      const challenge = await this.passkeyChallenge(
        this.paths.passkeyRegisterOptions,
        {},
        { headers: this.authorizationHeader() }
      );
      const created = await webAuthn.create({
        publicKey: parseCreationOptions(challenge.publicKey),
      });
      const body: Record<string, unknown> = {
        challenge_id: challenge.challengeId,
        credential: credentialToJSON(created),
      };
      if (input.name !== undefined) {
        body['name'] = input.name;
      }
      const response = await this.client.post<unknown>(
        this.paths.passkeyRegisterVerify,
        body,
        { retries: 0, headers: this.authorizationHeader() }
      );
      const record = (response.data as { passkey?: unknown } | null)?.passkey;
      const passkey = parsePasskey(record);
      if (passkey === null) {
        throw new Error(
          'The passkey registration response carried no passkey.'
        );
      }
      return { ok: true, passkey };
    } catch (error) {
      return this.settlePasskeyRefusal(error, REGISTER_REASONS);
    }
  }

  /**
   * Signs in with a passkey. Omit `email` for the discoverable flow; pass one
   * when the form already collected an address. An unknown address answers
   * identically to a known one, so this cannot be used to find accounts.
   * Resolves to an `mfa-required` outcome when the authenticator reported no
   * user verification and the account has TOTP, to be finished with
   * `completeTotp`. `mediation: 'conditional'` uses the autofill dropdown.
   *
   * @example
   * ```ts
   * const outcome = await auth.signInWithPasskey();
   * if (!outcome.ok) {
   *   if (outcome.reason !== 'cancelled') setBanner(outcome.message);
   * } else if (outcome.kind === 'mfa-required') {
   *   setPendingTicket(outcome.ticket);
   * } else {
   *   navigate('/');
   * }
   * ```
   */
  async signInWithPasskey(
    input: {
      email?: string;
      mediation?: 'silent' | 'optional' | 'conditional' | 'required';
      signal?: AbortSignal;
    } = {}
  ): Promise<PasskeySignInOutcome> {
    try {
      const webAuthn = this.requireWebAuthn();
      const challenge = await this.passkeyChallenge(
        this.paths.passkeyLoginOptions,
        input.email === undefined ? {} : { email: input.email }
      );
      const request: Record<string, unknown> = {
        publicKey: parseRequestOptions(challenge.publicKey),
      };
      if (input.mediation !== undefined) {
        request['mediation'] = input.mediation;
      }
      if (input.signal !== undefined) {
        request['signal'] = input.signal;
      }
      const assertion = await webAuthn.get(request);
      const outcome = await this.runTokenCall(this.paths.passkeyLoginVerify, {
        challenge_id: challenge.challengeId,
        credential: credentialToJSON(assertion),
      });
      return outcome.mfaRequired
        ? {
            ok: true,
            kind: 'mfa-required',
            ticket: outcome.ticket,
            factors: outcome.factors,
          }
        : {
            ok: true,
            kind: 'signed-in',
            user: outcome.user,
            expiresIn: outcome.expiresIn,
          };
    } catch (error) {
      return this.settlePasskeyRefusal(error, SIGN_IN_REASONS);
    }
  }

  /**
   * Every passkey on the signed-in account. The public key is not in the
   * response: a settings page has no use for it.
   */
  async listPasskeys(): Promise<PasskeyListOutcome> {
    try {
      const response = await this.client.get<unknown>(this.paths.passkeys, {
        headers: this.authorizationHeader(),
      });
      return { ok: true, passkeys: parsePasskeys(response.data) };
    } catch (error) {
      return this.settlePasskeyRefusal(error, PASSKEY_LIST_REASONS);
    }
  }

  /**
   * Relabels one of the caller's own passkeys. The server trims and caps the
   * name and refuses an empty one with `name-required`, which is a form-field
   * error and so an outcome here.
   */
  async renamePasskey(
    credentialId: string,
    name: string
  ): Promise<PasskeyRenameOutcome> {
    try {
      const response = await this.client.patch<unknown>(
        this.passkeyItemPath(credentialId),
        { name },
        { retries: 0, headers: this.authorizationHeader() }
      );
      const passkey = parsePasskey(
        (response.data as { passkey?: unknown } | null)?.passkey
      );
      if (passkey === null) {
        throw new Error('The passkey rename response carried no passkey.');
      }
      return { ok: true, passkey };
    } catch (error) {
      return this.settlePasskeyRefusal(error, RENAME_REASONS);
    }
  }

  /**
   * Removes one of the caller's own passkeys. Refused with `last-credential`
   * when it is the only one on an account with no password, which is an outcome
   * rather than a throw because the remedy is to set a password first.
   */
  async deletePasskey(credentialId: string): Promise<PasskeyDeleteOutcome> {
    try {
      await this.client.delete(this.passkeyItemPath(credentialId), {
        retries: 0,
        headers: this.authorizationHeader(),
      });
      return { ok: true };
    } catch (error) {
      return this.settlePasskeyRefusal(error, DELETE_REASONS);
    }
  }

  /** `<collection>/<credential id>`, the path the rename and the delete share. */
  private passkeyItemPath(credentialId: string): string {
    return `${this.paths.passkeys}/${encodeURIComponent(credentialId)}`;
  }

  /** Posts an options leg and reads the challenge off it. */
  private async passkeyChallenge(
    path: string,
    body: Record<string, unknown>,
    init: { headers?: Record<string, string> } = {}
  ): Promise<PasskeyChallenge> {
    const response = await this.client.post<unknown>(path, body, {
      retries: 0,
      ...init,
    });
    return parsePasskeyChallenge(response.data);
  }

  /**
   * Turns a thrown passkey error into a modelled refusal, or rethrows. A refusal
   * is not a session ending, so `status` goes back to what the token says, while
   * a 401 the client could not repair is left to throw.
   */
  private settlePasskeyRefusal<TReason extends PasskeyRefusal['reason']>(
    error: unknown,
    reasons: ReadonlySet<TReason>
  ): Extract<PasskeyRefusal, { reason: TReason }> {
    const refused = classifyPasskeyError(error, reasons);
    this.setState({
      status: this.accessToken === null ? 'anonymous' : 'authenticated',
      hasAccessToken: this.accessToken !== null,
      error:
        refused === null
          ? error instanceof Error
            ? error
            : new Error(String(error))
          : null,
    });
    if (refused === null) {
      throw error;
    }
    return refused;
  }

  /**
   * The URL to send the browser to for an OAuth login or link. A builder rather
   * than a call, since the start route answers with a cross-origin redirect that
   * script cannot follow, and an `href` is what a provider button wants. `mode`
   * is recorded on the server-side state row, so a login callback cannot be
   * steered into an attach; use {@link linkOAuthProvider} for the link flow,
   * which needs a bearer token a navigation will not carry.
   *
   * @example
   * ```tsx
   * <a href={auth.oauthStartUrl('google', { returnTo: '/dashboard' })}>
   *   Sign in with Google
   * </a>
   * ```
   */
  oauthStartUrl(provider: string, options: OAuthStartOptions = {}): string {
    const query = new URLSearchParams();
    if (options.returnTo !== undefined) {
      query.set('return_to', options.returnTo);
    }
    if (options.mode !== undefined) {
      query.set('mode', options.mode);
    }
    if (options.redirectUri !== undefined) {
      query.set('redirect_uri', options.redirectUri);
    }
    const suffix = query.toString();
    const base = this.client.baseUrl;
    const path = `${this.paths.oauthStart}/${encodeURIComponent(provider)}/start`;
    return `${base}${path}${suffix === '' ? '' : `?${suffix}`}`;
  }

  /**
   * Starts an OAuth login or link with a full page redirect. {@link oauthStartUrl}
   * plus the navigation, for a caller driving the flow from a button. Returns
   * void, because the page is leaving.
   */
  startOAuth(provider: string, options: OAuthStartOptions = {}): void {
    const url = this.oauthStartUrl(provider, options);
    const navigate =
      this.options.navigate ??
      ((target: string) => {
        globalThis.location.assign(target);
      });
    navigate(url);
  }

  /**
   * Starts a link for the signed-in caller, returning the URL to send them to.
   * JSON rather than a redirect, because this route is called with an
   * `Authorization` header that `fetch` would drop on a redirect. The subject
   * comes from the verified token claims, never from the body.
   *
   * @example
   * ```ts
   * const outcome = await auth.linkOAuthProvider('github', {
   *   returnTo: '/settings/security',
   * });
   * if (outcome.ok) {
   *   window.location.assign(outcome.authorizationUrl);
   * } else {
   *   setBanner(outcome.message);
   * }
   * ```
   */
  async linkOAuthProvider(
    provider: string,
    options: Omit<OAuthStartOptions, 'mode'> = {}
  ): Promise<OAuthLinkOutcome> {
    const body: Record<string, unknown> = {};
    if (options.returnTo !== undefined) {
      body['return_to'] = options.returnTo;
    }
    if (options.redirectUri !== undefined) {
      body['redirect_uri'] = options.redirectUri;
    }
    try {
      const response = await this.client.post<{ authorization_url?: unknown }>(
        this.oauthLinkPath(provider),
        body,
        { retries: 0, headers: this.authorizationHeader() }
      );
      const url = response.data.authorization_url;
      return {
        ok: true,
        authorizationUrl: typeof url === 'string' ? url : '',
      };
    } catch (error) {
      return this.settleOAuthRefusal(error, LINK_REASONS);
    }
  }

  /**
   * Every provider currently attached to the signed-in account. The provider
   * subject is not in the response, since echoing another system's identifier
   * into a body is how it ends up in a log.
   */
  async listOAuthLinks(): Promise<OAuthLinksOutcome> {
    try {
      const response = await this.client.get<unknown>(this.paths.oauthLinks, {
        headers: this.authorizationHeader(),
      });
      return { ok: true, links: parseOAuthLinks(response.data) };
    } catch (error) {
      return this.settleOAuthRefusal(error, LIST_REASONS);
    }
  }

  /**
   * Detaches a provider, unless it is the last way into the account. Refused
   * with `last-sign-in-method`, a named outcome rather than a throw because the
   * remedy is to set a password first: removing the last method locks the user
   * out permanently.
   */
  async unlinkOAuthProvider(provider: string): Promise<OAuthUnlinkOutcome> {
    try {
      await this.client.delete(this.oauthLinkPath(provider), {
        retries: 0,
        headers: this.authorizationHeader(),
      });
      return { ok: true };
    } catch (error) {
      return this.settleOAuthRefusal(error, UNLINK_REASONS);
    }
  }

  /** `<prefix>/<provider>/link`, the path the attach and the detach share. */
  private oauthLinkPath(provider: string): string {
    return `${this.paths.oauthStart}/${encodeURIComponent(provider)}/link`;
  }

  /**
   * Turns a thrown OAuth error into a modelled refusal, or rethrows. A refusal is
   * not a session ending, so `status` goes back to what the token says, while a
   * 401 the client could not repair is left to throw.
   */
  private settleOAuthRefusal<TReason extends OAuthRefusal['reason']>(
    error: unknown,
    reasons: ReadonlySet<TReason>
  ): Extract<OAuthRefusal, { reason: TReason }> {
    const refused = classifyOAuthError(error, reasons);
    this.setState({
      status: this.accessToken === null ? 'anonymous' : 'authenticated',
      hasAccessToken: this.accessToken !== null,
      error:
        refused === null
          ? error instanceof Error
            ? error
            : new Error(String(error))
          : null,
    });
    if (refused === null) {
      throw error;
    }
    return refused;
  }

  /**
   * Signs out. Calls the backend, which revokes the whole refresh family and
   * clears the cookie, then clears memory whether or not the call succeeded, and
   * fires `onSessionEnded` exactly once.
   */
  async logout(options: { everywhere?: boolean } = {}): Promise<void> {
    const path =
      options.everywhere === true ? this.paths.logoutAll : this.paths.logout;
    const headers = this.authorizationHeader();
    this.setState({ status: 'loading', error: null });
    try {
      await this.client.post(path, undefined, { retries: 0, headers });
      // eslint-disable-next-line no-empty
    } catch {
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

  /**
   * Asks the backend to mail a verification link. Anonymous and keyed by
   * address, since the user who needs it has no session. It resolves the same
   * way whatever the address is, so a caller must not try to tell an unknown
   * address from a known one. Returns `ok: false` only for a rate limit or a
   * deployment with no sender.
   */
  async requestEmailVerification(input: {
    email: string;
  }): Promise<EmailRequestOutcome> {
    return this.runEmailRequest(this.paths.verifyEmail, input.email);
  }

  /**
   * Confirms a verification link and marks the address verified. Anonymous, and
   * a POST, so a mail scanner following the link cannot spend the token.
   * Unknown, expired, spent and wrong-purpose tokens are one `invalid-link`
   * outcome, because the difference is information about somebody else's token.
   */
  async confirmEmailVerification(input: {
    token: string;
  }): Promise<EmailVerificationOutcome> {
    try {
      const response = await this.client.post<{ user_id?: unknown }>(
        this.paths.verifyEmailConfirm,
        { token: input.token },
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
   * Asks the backend to mail a password reset link. Answers identically whether
   * or not the address has an account; render the server's `detail` rather than
   * a local sentence.
   */
  async requestPasswordReset(input: {
    email: string;
  }): Promise<EmailRequestOutcome> {
    return this.runEmailRequest(this.paths.passwordReset, input.email);
  }

  /**
   * Spends a reset link and sets a new password. Every session for the account
   * is revoked, this browser's included, so the client drops its own token and
   * the user signs in again. Three refusals, because the remedies differ:
   * `invalid-link`, `password-rejected` and `rate-limited`. `familyIds` is an
   * exact-revocation seam almost no caller has.
   */
  async confirmPasswordReset(input: {
    token: string;
    newPassword: string;
    familyIds?: string[];
  }): Promise<PasswordResetOutcome> {
    const body: Record<string, unknown> = {
      token: input.token,
      new_password: input.newPassword,
    };
    if (input.familyIds !== undefined) {
      body['family_ids'] = input.familyIds;
    }
    try {
      await this.client.post(this.paths.passwordResetConfirm, body, {
        retries: 0,
      });
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
   * The shared body of the two request routes. Written once because the two are
   * the same shape by design, and because one implementation is one place to
   * check that neither leaks whether the address exists.
   */
  private async runEmailRequest(
    path: string,
    email: string
  ): Promise<EmailRequestOutcome> {
    try {
      const response = await this.client.post<{ detail?: unknown }>(
        path,
        { email },
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

  /**
   * Starts a TOTP enrolment and returns the seed, once. The factor is written
   * inactive, so it gates nothing until {@link activateTotp} sees a correct
   * code. Calling again replaces a pending enrolment with a new seed; an account
   * with an active factor is refused with `already-enabled`, and the path to
   * replacing one is disable then enrol. Render `provisioningUri` as a QR code
   * and `secret` as the typed fallback.
   */
  async enrolTotp(): Promise<TotpEnrolmentOutcome> {
    return this.runMfaCall(
      this.paths.totpEnrol,
      {},
      ENROL_REASONS,
      (data: { secret?: unknown; provisioning_uri?: unknown }) => ({
        ok: true as const,
        secret: typeof data.secret === 'string' ? data.secret : '',
        provisioningUri:
          typeof data.provisioning_uri === 'string'
            ? data.provisioning_uri
            : '',
      })
    );
  }

  /**
   * Activates a pending enrolment with its first correct code, returning the
   * recovery codes the server issues with it. They are shown exactly once, since
   * the server stores only their hashes, and the code just used cannot be
   * replayed as a login code.
   */
  async activateTotp(input: { code: string }): Promise<TotpActivationOutcome> {
    return this.runMfaCall(
      this.paths.totpActivate,
      { code: input.code },
      ACTIVATE_REASONS,
      (data: RecoveryCodesBody) => ({
        ok: true as const,
        recoveryCodes: asStringArray(data.recovery_codes),
      })
    );
  }

  /**
   * Removes the factor and every recovery code with it, since codes left behind
   * satisfy a factor the user believes is gone. Requires a current TOTP code or
   * an unspent recovery code, because turning the second factor off is what a
   * stolen access token would most want. A bad code comes back as
   * `invalid-code`.
   */
  async disableTotp(input: { code: string }): Promise<TotpDisableOutcome> {
    return this.runMfaCall(
      this.paths.totpDisable,
      { code: input.code },
      CODE_REASONS,
      () => ({ ok: true as const })
    );
  }

  /**
   * Replaces every recovery code with a fresh set, returned once. The old set is
   * deleted first, which is the point of regenerating after a lost printout.
   * Requires a code for the same reason {@link disableTotp} does.
   */
  async regenerateRecoveryCodes(input: {
    code: string;
  }): Promise<RecoveryCodesOutcome> {
    return this.runMfaCall(
      this.paths.recoveryCodes,
      { code: input.code },
      CODE_REASONS,
      (data: RecoveryCodesBody) => ({
        ok: true as const,
        recoveryCodes: asStringArray(data.recovery_codes),
      })
    );
  }

  /**
   * Re-authenticates inside the current session for a fresher access token. Not
   * a second login: no refresh family is started and the cookie is untouched,
   * but the new token's `auth_time` and `amr` let a sensitive route assert on
   * freshness. The token is adopted into the in-memory store and the timer
   * re-armed, so it is not in the outcome. `code` takes a TOTP or recovery code,
   * which the server tells apart by shape.
   */
  async stepUp(input: { code: string }): Promise<StepUpOutcome> {
    this.setState({ status: 'loading', error: null });
    try {
      const response = await this.client.post<TokenResponseBody>(
        this.paths.stepUp,
        { code: input.code },
        { retries: 0, headers: this.authorizationHeader() }
      );
      const token = response.data.access_token;
      if (typeof token !== 'string' || token === '') {
        throw new AuthSessionEndedError({
          message: 'The step-up response carried no access token.',
          reason: 'refresh-failed',
        });
      }
      const expiresIn =
        typeof response.data.expires_in === 'number'
          ? response.data.expires_in
          : undefined;
      this.adoptToken(token, expiresIn);
      this.setState({
        status: 'authenticated',
        hasAccessToken: true,
        error: null,
      });
      return { ok: true, expiresIn };
    } catch (error) {
      return this.settleMfaRefusal(error, CODE_REASONS);
    }
  }

  /**
   * The shared body of the four MFA calls that are a plain post and a mapping.
   * `stepUp` is not routed through it, being the only one that adopts a token
   * and so has a success path of its own.
   */
  private async runMfaCall<
    TBody,
    TOk extends { ok: true },
    TReason extends MfaRefusal['reason'],
  >(
    path: string,
    body: Record<string, unknown>,
    reasons: ReadonlySet<TReason>,
    toOutcome: (data: TBody) => TOk
  ): Promise<TOk | Extract<MfaRefusal, { reason: TReason }>> {
    try {
      const response = await this.client.post<TBody>(path, body, {
        retries: 0,
        headers: this.authorizationHeader(),
      });
      return toOutcome(response.data);
    } catch (error) {
      return this.settleMfaRefusal(error, reasons);
    }
  }

  /**
   * Turns a thrown MFA error into a modelled refusal, or rethrows. A refusal is
   * not a session ending, so `status` goes back to what the token says and the
   * error is not parked in `state.error`, while a 401 the client could not
   * repair is left to throw.
   */
  private settleMfaRefusal<TReason extends MfaRefusal['reason']>(
    error: unknown,
    reasons: ReadonlySet<TReason>
  ): Extract<MfaRefusal, { reason: TReason }> {
    const refused = classifyMfaError(error, reasons);
    this.setState({
      status: this.accessToken === null ? 'anonymous' : 'authenticated',
      hasAccessToken: this.accessToken !== null,
      error:
        refused === null
          ? error instanceof Error
            ? error
            : new Error(String(error))
          : null,
    });
    if (refused === null) {
      throw error;
    }
    return refused;
  }

  private authorizationHeader(): Record<string, string> {
    return this.accessToken === null
      ? {}
      : { authorization: `Bearer ${this.accessToken}` };
  }

  /**
   * The WebAuthn adapter, defaulting to `navigator.credentials`. It receives the
   * whole options wrapper rather than the bare `publicKey` document, because a
   * conditional sign-in also needs `mediation` and `signal`, which is what makes
   * `navigator.credentials` itself a valid adapter.
   */
  private requireWebAuthn(): WebAuthnAdapter {
    if (this.options.webAuthn !== undefined) {
      return this.options.webAuthn;
    }
    const credentials = (
      globalThis as { navigator?: { credentials?: unknown } }
    ).navigator?.credentials as WebAuthnAdapter | undefined;
    if (credentials === undefined) {
      throw new Error(
        'WebAuthn is not available in this environment. Pass a webAuthn adapter to createAuthClient.'
      );
    }
    return {
      create: (options: unknown) => credentials.create(options),
      get: (options: unknown) => credentials.get(options),
    };
  }

  /**
   * Posts to a route that answers with a token, an MFA challenge, or an error.
   * Shared by every login shaped call, so the MFA branch, the token adoption and
   * the error handling are written once. None of these routes retries.
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
   * Writes a user into the store without a round trip, for a caller that already
   * has a fresher copy: the response to a profile edit, or a user the
   * application fetched itself. It touches neither token nor cookie, and leaves
   * `status` alone rather than promoting an anonymous client to authenticated,
   * since a user object is not a session.
   */
  setUser(user: TUser): void {
    this.setState({ user });
  }

  /**
   * Re-reads the user through the `loadUser` hook, for a caller that changed
   * something the profile reflects. It rotates nothing: the access token and the
   * refresh cookie are untouched, so this is the call to reach for instead of
   * `refresh`, which would spend a rotation to learn a name. Resolves to the
   * current user unchanged when no `loadUser` was configured.
   *
   * A 401 means the token this client holds is no longer good, so the session is
   * ended exactly as a failed refresh ends it, `onSessionEnded` included. Any
   * other failure leaves the session alone and lands in `error`, because a
   * profile route being down is not a reason to sign someone out.
   */
  async reloadUser(): Promise<TUser | null> {
    const loadUser = this.options.loadUser;
    if (loadUser === undefined) {
      return this.state.user;
    }
    try {
      const user = await loadUser(this.client);
      this.setState({ user, error: null });
      return user;
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        const ended = new AuthSessionEndedError({
          message: error.message,
          code: getAuthErrorCode(error),
          reason: 'refresh-failed',
          cause: error,
        });
        this.endSession(ended, { notify: true, recordError: false });
        return null;
      }
      this.setState({
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return this.state.user;
    }
  }

  /**
   * Moves to the authenticated state, loading the user when a hook was given. A
   * `loadUser` that throws does not undo the session: the token is valid, and a
   * null user is a better outcome than signing someone out.
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
      sessionEnded: null,
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
