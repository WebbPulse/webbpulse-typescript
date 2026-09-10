import { ApiError, type ApiClient } from '@webbpulse/api-client';

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
  'unknown' | 'loading' | 'authenticated' | 'anonymous';

/** Immutable snapshot of the session. */
export interface SessionState<TUser> {
  status: SessionStatus;
  user: TUser | null;
  /** Last error from a session operation, cleared on the next success. */
  error: Error | null;
}

/**
 * How a session is carried.
 *
 * Cookie only since 0.4.0. The `'token'` mode kept a bearer token in
 * `localStorage`, which section 7.1 of the identity standard removes: a token
 * any script on the page can read, that survives the tab, is the standard XSS
 * prize. `AuthClient` is the replacement for anything that needs a bearer
 * token, and it holds it in memory.
 *
 * The type is kept as a one-member union rather than deleted so an existing
 * `mode: 'cookie'` call site still reads the same, and a `mode: 'token'` one
 * fails to compile with the mode named rather than with a missing export.
 */
export type SessionMode = 'cookie';

export interface SessionManagerOptions<TUser, TCredentials> {
  /** Client used for every session call. */
  client: ApiClient;
  /** Always `'cookie'`. See {@link SessionMode}. */
  mode: SessionMode;
  /** Path returning the signed in user. Defaults to `/users/me`. */
  currentUserPath?: string;
  /** Path accepting credentials. Defaults to `/auth/token`. */
  loginPath?: string;
  /** Path ending the session. Defaults to `/auth/logout`. */
  logoutPath?: string;
  /**
   * Encodes credentials for the login request.
   *
   * Defaults to sending the object as JSON, which is Portfolio's
   * `/admin/login`. CarModPicker posts form encoded to an OAuth2 password
   * flow endpoint, so it passes a function returning `URLSearchParams`.
   */
  encodeCredentials?: (credentials: TCredentials) => unknown;
  /**
   * Reports whether a login response completed the session.
   *
   * Return `false` when the API signalled that a second factor is still
   * needed, so the manager leaves the state anonymous and the caller drives
   * the next leg from `raw`. Defaults to treating every non-error response as
   * complete, which is what a cookie session that issued its cookie means.
   */
  isLoginComplete?: (response: unknown) => boolean;
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
  }

  /** Current snapshot. */
  getState(): SessionState<TUser> {
    return this.state;
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

      const isComplete = this.options.isLoginComplete ?? (() => true);
      const complete = isComplete(response.data);

      const extractUser = this.options.extractUser ?? defaultExtractUser<TUser>;
      let user = extractUser(response.data);
      if (user === null && complete) {
        // The API authenticated us but did not embed the user, so ask for it.
        user = await this.refresh();
      }

      if (user === null) {
        // No user and an incomplete flow, a pending second factor being the
        // usual reason. Leave the caller to drive the next step from `raw`
        // rather than claiming a session that does not exist.
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
