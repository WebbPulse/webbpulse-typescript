import { ApiError, type ApiClient } from '@webbpulse/api-client';
import { TokenStore, type TokenStorage } from './storage.js';

/**
 * Session state, in the shape both applications need.
 *
 * `status` is a single field rather than the separate `isAuthenticated` and
 * `isLoading` booleans CarModPicker's AuthContext carries. Those two can
 * express `{ isAuthenticated: true, isLoading: true }`, which is meaningless,
 * and Portfolio's `useState(false)` plus mount effect produces exactly the
 * flash of signed out UI that a distinct `'unknown'` state prevents.
 */
export type SessionStatus =
  | 'unknown'
  | 'loading'
  | 'authenticated'
  | 'anonymous';

/** Immutable snapshot of the session. */
export interface SessionState<TUser> {
  status: SessionStatus;
  user: TUser | null;
  /** Last error from a session operation, cleared on the next success. */
  error: Error | null;
}

/** How a session is carried. */
export type SessionMode =
  /** Bearer token in `localStorage`, sent on every request. */
  | 'token'
  /** HttpOnly cookie set by the API; the browser carries it. */
  | 'cookie';

export interface SessionManagerOptions<TUser, TCredentials> {
  /** Client used for every session call. */
  client: ApiClient;
  /** Token or cookie. Decides whether a token store is used at all. */
  mode: SessionMode;
  /** Path returning the signed in user. Defaults to `/users/me`. */
  currentUserPath?: string;
  /** Path accepting credentials. Defaults to `/auth/token`. */
  loginPath?: string;
  /** Path ending the session. Defaults to `/auth/logout`. */
  logoutPath?: string;
  /** localStorage key. Required in `'token'` mode. */
  tokenStorageKey?: string;
  /** Storage backend. Defaults to `localStorage` when usable. */
  tokenStorage?: TokenStorage;
  /**
   * Encodes credentials for the login request.
   *
   * Defaults to sending the object as JSON, which is Portfolio's
   * `/admin/login`. CarModPicker posts form encoded to an OAuth2 password
   * flow endpoint, so it passes a function returning `URLSearchParams`.
   */
  encodeCredentials?: (credentials: TCredentials) => unknown;
  /**
   * Pulls the token out of a login response. Return `null` for a cookie
   * session, or when the API signalled that a second factor is still needed.
   */
  extractToken?: (response: unknown) => string | null;
  /**
   * Pulls the user out of a login response, or returns `null` to make the
   * manager fetch the current user separately after logging in.
   */
  extractUser?: (response: unknown) => TUser | null;
}

/** Result of a login attempt. */
export interface LoginResult<TUser> {
  user: TUser | null;
  /** The raw login response, for flows this package does not model, such as 2FA. */
  raw: unknown;
}

function defaultExtractToken(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const token = (response as { access_token?: unknown }).access_token;
  return typeof token === 'string' && token !== '' ? token : null;
}

function defaultExtractUser<TUser>(response: unknown): TUser | null {
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const user = (response as { user?: unknown }).user;
  return user === undefined || user === null ? null : (user as TUser);
}

/**
 * Framework free session manager.
 *
 * Holds the state, exposes the flows as plain async methods, and notifies
 * subscribers on every change. The React entry point at `@webbpulse/auth/react`
 * is a thin binding over this; nothing here imports React.
 */
export class SessionManager<TUser = unknown, TCredentials = unknown> {
  private readonly options: SessionManagerOptions<TUser, TCredentials>;
  private readonly tokenStore: TokenStore | null;
  private readonly listeners = new Set<(state: SessionState<TUser>) => void>();
  private state: SessionState<TUser> = {
    status: 'unknown',
    user: null,
    error: null,
  };
  /** De-duplicates concurrent refreshes, so a burst of mounts makes one call. */
  private inFlight: Promise<TUser | null> | null = null;

  constructor(options: SessionManagerOptions<TUser, TCredentials>) {
    this.options = options;
    if (options.mode === 'token') {
      if (
        options.tokenStorageKey === undefined ||
        options.tokenStorageKey === ''
      ) {
        throw new Error(
          "tokenStorageKey is required when mode is 'token'. The two applications use different keys, so there is no safe default."
        );
      }
      this.tokenStore = new TokenStore(
        options.tokenStorageKey,
        options.tokenStorage
      );
    } else {
      this.tokenStore = null;
    }
  }

  /** Current snapshot. */
  getState(): SessionState<TUser> {
    return this.state;
  }

  /** Stored token, or null in cookie mode. */
  getToken(): string | null {
    return this.tokenStore?.get() ?? null;
  }

  /**
   * Stores a token the API rotated in mid session.
   *
   * Wire this to the client's `onTokenRefresh` so a username change, which
   * makes the backend reissue the token in a response header, does not sign
   * the user out on their next request.
   */
  setToken(token: string): void {
    this.tokenStore?.set(token);
  }

  /** Subscribes to changes. Returns the unsubscribe function. */
  subscribe(listener: (state: SessionState<TUser>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: SessionState<TUser>): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /**
   * Fetches the current user and updates the state.
   *
   * A 401 is an expected answer, not a failure: it means nobody is signed in.
   * It resolves to `null` with status `'anonymous'` and clears any stale token,
   * and only a non-401 error is recorded on the state.
   */
  async refresh(): Promise<TUser | null> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.setState({ ...this.state, status: 'loading', error: null });

    const run = async (): Promise<TUser | null> => {
      try {
        const response = await this.options.client.get<TUser>(
          this.options.currentUserPath ?? '/users/me'
        );
        this.setState({
          status: 'authenticated',
          user: response.data,
          error: null,
        });
        return response.data;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) {
          this.tokenStore?.clear();
          this.setState({ status: 'anonymous', user: null, error: null });
          return null;
        }
        this.setState({
          status: 'anonymous',
          user: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return null;
      } finally {
        this.inFlight = null;
      }
    };

    this.inFlight = run();
    return this.inFlight;
  }

  /**
   * Signs in.
   *
   * Stores the token when the response carries one, then resolves the user
   * either from the login response or, when the API does not embed it, with a
   * follow up call to the current user endpoint. Errors propagate: a failed
   * login must be visible to the form that triggered it.
   */
  async login(credentials: TCredentials): Promise<LoginResult<TUser>> {
    this.setState({ ...this.state, status: 'loading', error: null });
    try {
      const encode =
        this.options.encodeCredentials ?? ((value: TCredentials) => value);
      const response = await this.options.client.post<unknown>(
        this.options.loginPath ?? '/auth/token',
        encode(credentials)
      );

      const extractToken = this.options.extractToken ?? defaultExtractToken;
      const token = extractToken(response.data);
      if (token !== null) {
        this.tokenStore?.set(token);
      }

      const extractUser =
        this.options.extractUser ?? defaultExtractUser<TUser>;
      let user = extractUser(response.data);
      if (user === null && (token !== null || this.options.mode === 'cookie')) {
        // The API authenticated us but did not embed the user, so ask for it.
        user = await this.refresh();
      }

      if (user === null) {
        // No user and no token means the flow is unfinished, a pending second
        // factor being the usual reason. Leave the caller to drive the next
        // step from `raw` rather than claiming a session that does not exist.
        this.setState({ status: 'anonymous', user: null, error: null });
      } else {
        this.setState({ status: 'authenticated', user, error: null });
      }
      return { user, raw: response.data };
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      this.setState({ status: 'anonymous', user: null, error: asError });
      throw asError;
    }
  }

  /**
   * Signs out.
   *
   * Clears local state whether or not the server call succeeds. A network
   * failure must not strand the user in a session the UI still believes in.
   */
  async logout(): Promise<void> {
    this.setState({ ...this.state, status: 'loading', error: null });
    try {
      await this.options.client.post(this.options.logoutPath ?? '/auth/logout');
    } catch {
      // Deliberately swallowed. The local session is ended regardless.
    } finally {
      this.tokenStore?.clear();
      this.setState({ status: 'anonymous', user: null, error: null });
    }
  }

  /** Sets the user directly, for a flow that authenticated out of band. */
  setUser(user: TUser | null): void {
    this.setState({
      status: user === null ? 'anonymous' : 'authenticated',
      user,
      error: null,
    });
  }
}
