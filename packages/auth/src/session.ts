import { ApiError, type ApiClient } from '@webbpulse/api-client';

/**
 * Session state. `status` is one field rather than separate booleans, so an
 * impossible pair cannot be expressed and `'unknown'` prevents a flash of
 * signed out UI before the first check resolves.
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
 * How a session is carried. Cookie only: a bearer token in `localStorage` is
 * readable by any script on the page, so `AuthClient` holds one in memory
 * instead. Kept as a one-member union so a removed mode names itself.
 */
export type SessionMode = 'cookie';

/** Construction options for a {@link SessionManager}. */
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
   * Encodes credentials for the login request. Defaults to JSON; return
   * `URLSearchParams` for a form encoded endpoint such as an OAuth2 password
   * flow.
   */
  encodeCredentials?: (credentials: TCredentials) => unknown;
  /**
   * Reports whether a login response completed the session. Return `false`
   * when a second factor is still needed, so the state stays anonymous and the
   * caller drives the next leg from `raw`.
   */
  isLoginComplete?: (response: unknown) => boolean;
  /**
   * Pulls the user out of a login response, or returns `null` to make the
   * manager fetch the current user separately.
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
 * Framework free session manager. Holds the state, exposes the flows as async
 * methods, and notifies subscribers on every change; the React entry point is a
 * thin binding over it.
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
   * Fetches the current user and updates the state. A 401 means nobody is
   * signed in, so it resolves to `null` as `'anonymous'` rather than an error.
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
   * Signs in, resolving the user from the login response or with a follow up
   * call when the API does not embed it. Errors propagate so the form that
   * triggered the login can show them.
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
        user = await this.refresh();
      }

      if (user === null) {
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
   * Signs out, clearing local state whether or not the server call succeeds so
   * a network failure cannot strand the user in a session the UI believes in.
   */
  async logout(): Promise<void> {
    this.setState({ ...this.state, status: 'loading', error: null });
    try {
      await this.options.client.post(this.options.logoutPath ?? '/auth/logout');
      // eslint-disable-next-line no-empty
    } catch {
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
