/**
 * React bindings. Separate entry point so `@webbpulse/auth` itself stays
 * framework free and an application that only needs the core never pulls React
 * into its bundle.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AuthClient, AuthState } from './auth-client.js';
import type { SessionManager, SessionState } from './session.js';

const SessionManagerContext = createContext<SessionManager<
  unknown,
  unknown
> | null>(null);

/**
 * A manager of any user and credential type.
 *
 * The context erases both generics, because one provider serves components
 * that each know their own user type, and the typed hooks below re-apply the
 * caller's parameters on the way out.
 *
 * `SessionManager` is invariant in both parameters, since each appears in both
 * an argument and a return position, so no single instantiation is assignable
 * from every other one. `SessionManager<never, never>` is the alias a caller
 * writes when the parameters genuinely do not matter, and the two casts below
 * route through `unknown` because the invariance, not a real shape mismatch, is
 * what TypeScript is objecting to.
 */
export type AnySessionManager = SessionManager<never, never>;

export interface SessionProviderProps {
  /** The manager to expose. Construct it once, outside the component tree. */
  manager: AnySessionManager;
  /**
   * Fetches the current user on mount. Defaults to true, which is what both
   * applications do today.
   */
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
 * Subscribes to session state.
 *
 * Uses `useSyncExternalStore`, so the manager stays the single source of truth
 * and concurrent rendering cannot tear a component onto a stale snapshot. The
 * manager returns the identical object when nothing changed, which is what
 * makes the default reference equality check correct here.
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

/**
 * The hook application code uses. Replaces CarModPicker's `useAuth` plus its
 * `AuthContext`, and the inline `useState` that Portfolio's `AdminPanel`
 * currently uses in place of an auth context.
 */
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

// ---------------------------------------------------------------------------
// AuthClient bindings, section 7.1
//
// A second context rather than a widened first one. `SessionManager` and
// `AuthClient` model different things: one is a cookie session whose state is
// "who is signed in", the other holds an access token and a refresh lifecycle.
// An application adopting the identity standard uses the second and can drop
// the first, and during the migration a page may legitimately sit under both.
// ---------------------------------------------------------------------------

const AuthClientContext = createContext<AuthClient<unknown> | null>(null);

/**
 * An auth client of any user type.
 *
 * `AuthClient` is invariant in `TUser`, since the parameter appears in both an
 * argument and a return position, so no single instantiation is assignable from
 * every other one. This is the alias a provider prop writes, and the typed
 * hooks re-apply the caller's parameter on the way out.
 */
export type AnyAuthClient = AuthClient<never>;

export interface AuthProviderProps {
  /** The client to expose. Construct it once, outside the component tree. */
  client: AnyAuthClient;
  /**
   * Runs the silent refresh on mount. Defaults to true, which is the behaviour
   * 7.1 requires: without it an in-memory token does not survive a reload and
   * every refresh of the page lands the user on a login screen.
   */
  initializeOnMount?: boolean;
  children: ReactNode;
}

/**
 * Puts an {@link AuthClient} in context and runs the silent refresh.
 *
 * The effect is safe under StrictMode's double mount, because `initialize` is
 * idempotent and shares one in-flight request: two mounts make one call to the
 * refresh endpoint, not two rotations of the same cookie.
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
 * Subscribes to auth state.
 *
 * `useSyncExternalStore` keeps the client the single source of truth and stops
 * concurrent rendering tearing a component onto a stale snapshot. The client
 * returns the identical object until something changes, which is what makes the
 * default reference equality check correct.
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
   * Signs in with a passkey. Replaces the 0.7.0 `loginWithPasskey` and
   * `completePasskeyMfa` pair: the MFA case is now an outcome of this one call
   * rather than a second method, and it is finished with `completeTotp`.
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
 * The hook application code uses.
 *
 * The methods are bound to the client and stable for its lifetime, so a
 * component can put them in a dependency array without re-running an effect on
 * every state change.
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
