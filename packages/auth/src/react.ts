/**
 * React bindings. A separate entry point so the core package stays framework
 * free and an application that only needs it never pulls React into its bundle.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AuthClient, AuthState } from './auth-client.js';
import {
  readOAuthCallback,
  stripOAuthParams,
  type OAuthCallbackResult,
} from './oauth.js';
import type { SessionManager, SessionState } from './session.js';

const SessionManagerContext = createContext<SessionManager<
  unknown,
  unknown
> | null>(null);

/**
 * A manager of any user and credential type. The context erases both generics
 * and the typed hooks re-apply the caller's on the way out, since
 * `SessionManager` is invariant in each and no instantiation is assignable from
 * every other.
 */
export type AnySessionManager = SessionManager<never, never>;

/** Props for {@link SessionProvider}. */
export interface SessionProviderProps {
  /** The manager to expose. Construct it once, outside the component tree. */
  manager: AnySessionManager;
  /** Fetches the current user on mount. Defaults to true. */
  refreshOnMount?: boolean;
  children: ReactNode;
}

/** Puts a `SessionManager` in context. */
export function SessionProvider({
  manager,
  refreshOnMount = true,
  children,
}: SessionProviderProps): ReactNode {
  const erased = manager as unknown as SessionManager<unknown, unknown>;

  useEffect(() => {
    if (refreshOnMount) {
      void erased.refresh();
    }
  }, [erased, refreshOnMount]);

  return createElement(
    SessionManagerContext.Provider,
    { value: erased },
    children
  );
}

/** Returns the manager from context. Throws outside a provider. */
export function useSessionManager<
  TUser = unknown,
  TCredentials = unknown,
>(): SessionManager<TUser, TCredentials> {
  const manager = useContext(SessionManagerContext);
  if (manager === null) {
    throw new Error('useSessionManager must be used within a SessionProvider.');
  }
  return manager as unknown as SessionManager<TUser, TCredentials>;
}

/**
 * Subscribes to session state through `useSyncExternalStore`, so the manager
 * stays the single source of truth and concurrent rendering cannot tear a
 * component onto a stale snapshot.
 */
export function useSessionState<TUser = unknown>(): SessionState<TUser> {
  const manager = useSessionManager<TUser>();
  const subscribe = useCallback(
    (onChange: () => void) => manager.subscribe(onChange),
    [manager]
  );
  const getSnapshot = useCallback(() => manager.getState(), [manager]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** What {@link useSession} returns. */
export interface UseSessionResult<
  TUser,
  TCredentials,
> extends SessionState<TUser> {
  isAuthenticated: boolean;
  /** True until the first current user fetch settles. */
  isLoading: boolean;
  login: (credentials: TCredentials) => Promise<TUser | null>;
  logout: () => Promise<void>;
  refresh: () => Promise<TUser | null>;
}

/** The hook application code uses for session state and the session flows. */
export function useSession<
  TUser = unknown,
  TCredentials = unknown,
>(): UseSessionResult<TUser, TCredentials> {
  const manager = useSessionManager<TUser, TCredentials>();
  const state = useSessionState<TUser>();

  const login = useCallback(
    async (credentials: TCredentials) => {
      const result = await manager.login(credentials);
      return result.user;
    },
    [manager]
  );

  const logout = useCallback(() => manager.logout(), [manager]);
  const refresh = useCallback(() => manager.refresh(), [manager]);

  return useMemo(
    () => ({
      ...state,
      isAuthenticated: state.status === 'authenticated',
      isLoading: state.status === 'loading' || state.status === 'unknown',
      login,
      logout,
      refresh,
    }),
    [state, login, logout, refresh]
  );
}

const AuthClientContext = createContext<AuthClient<unknown> | null>(null);

/**
 * An auth client of any user type. `AuthClient` is invariant in `TUser`, so a
 * provider prop writes this alias and the typed hooks re-apply the caller's
 * parameter on the way out.
 */
export type AnyAuthClient = AuthClient<never>;

/** Props for {@link AuthProvider}. */
export interface AuthProviderProps {
  /** The client to expose. Construct it once, outside the component tree. */
  client: AnyAuthClient;
  /**
   * Runs the silent refresh on mount. Defaults to true; without it an in-memory
   * token does not survive a reload.
   */
  initializeOnMount?: boolean;
  children: ReactNode;
}

/**
 * Puts an {@link AuthClient} in context and runs the silent refresh. Safe under
 * StrictMode's double mount, since `initialize` shares one in-flight request
 * rather than rotating the cookie twice.
 */
export function AuthProvider({
  client,
  initializeOnMount = true,
  children,
}: AuthProviderProps): ReactNode {
  const erased = client as unknown as AuthClient<unknown>;

  useEffect(() => {
    if (initializeOnMount) {
      void erased.initialize();
    }
  }, [erased, initializeOnMount]);

  return createElement(AuthClientContext.Provider, { value: erased }, children);
}

/** Returns the auth client from context. Throws outside a provider. */
export function useAuthClient<TUser = unknown>(): AuthClient<TUser> {
  const client = useContext(AuthClientContext);
  if (client === null) {
    throw new Error('useAuthClient must be used within an AuthProvider.');
  }
  return client as unknown as AuthClient<TUser>;
}

/**
 * Subscribes to auth state through `useSyncExternalStore`, which keeps the
 * client the single source of truth and stops concurrent rendering tearing a
 * component onto a stale snapshot.
 */
export function useAuthState<TUser = unknown>(): AuthState<TUser> {
  const client = useAuthClient<TUser>();
  const subscribe = useCallback(
    (onChange: () => void) => client.subscribe(onChange),
    [client]
  );
  const getSnapshot = useCallback(() => client.getState(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** What {@link useAuth} returns. */
export interface UseAuthResult<TUser> extends AuthState<TUser> {
  isAuthenticated: boolean;
  /** True until the first silent refresh settles, and during a session call. */
  isLoading: boolean;
  login: AuthClient<TUser>['login'];
  completeTotp: AuthClient<TUser>['completeTotp'];
  /**
   * Signs in with a passkey. An MFA challenge is an outcome of this call, to be
   * finished with `completeTotp`.
   */
  signInWithPasskey: AuthClient<TUser>['signInWithPasskey'];
  registerPasskey: AuthClient<TUser>['registerPasskey'];
  listPasskeys: AuthClient<TUser>['listPasskeys'];
  renamePasskey: AuthClient<TUser>['renamePasskey'];
  deletePasskey: AuthClient<TUser>['deletePasskey'];
  startOAuth: AuthClient<TUser>['startOAuth'];
  logout: AuthClient<TUser>['logout'];
  /** The in-memory access token, or null. Rarely needed in a component. */
  getAccessToken: () => string | null;
}

/**
 * The hook application code uses. The methods are bound and stable for the
 * client's lifetime, so a component can put them in a dependency array safely.
 */
export function useAuth<TUser = unknown>(): UseAuthResult<TUser> {
  const client = useAuthClient<TUser>();
  const state = useAuthState<TUser>();

  const bound = useMemo(
    () => ({
      login: client.login.bind(client),
      completeTotp: client.completeTotp.bind(client),
      signInWithPasskey: client.signInWithPasskey.bind(client),
      registerPasskey: client.registerPasskey.bind(client),
      listPasskeys: client.listPasskeys.bind(client),
      renamePasskey: client.renamePasskey.bind(client),
      deletePasskey: client.deletePasskey.bind(client),
      startOAuth: client.startOAuth.bind(client),
      logout: client.logout.bind(client),
      getAccessToken: client.getAccessToken.bind(client),
    }),
    [client]
  );

  return useMemo(
    () => ({
      ...state,
      isAuthenticated: state.status === 'authenticated',
      isLoading: state.status === 'loading' || state.status === 'unknown',
      ...bound,
    }),
    [state, bound]
  );
}

/** What {@link useOAuthCallback} is told, once, when the page was a callback landing. */
export type OAuthCallbackHandler = (
  result: OAuthCallbackResult
) => void | Promise<void>;

/**
 * Runs `onCallback` when the page was reached from an OAuth callback, then
 * strips the single-use parameters with `history.replaceState` so a reload or a
 * shared link cannot replay a live MFA ticket. A ref guards the read, since
 * StrictMode mounts effects twice, and holds the latest handler so a caller need
 * not memoise it. A no-op on every ordinary visit.
 */
export function useOAuthCallback(onCallback: OAuthCallbackHandler): void {
  const handled = useRef(false);
  const handler = useRef(onCallback);
  handler.current = onCallback;

  useEffect(() => {
    if (handled.current) {
      return;
    }
    handled.current = true;
    const href = globalThis.location.href;
    const result = readOAuthCallback(href);
    if (result === null) {
      return;
    }
    globalThis.history.replaceState(null, '', stripOAuthParams(href));
    void handler.current(result);
  }, []);
}
