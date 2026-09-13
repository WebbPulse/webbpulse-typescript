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
import type { AuthSessionEndedError } from './errors.js';
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
  /**
   * True only until the session has settled once. It answers "is the session
   * still unknown", so a route guard can hold a tree back on it and will not
   * unmount that tree again when a later call is in flight. Gate a button
   * spinner on {@link UseSessionResult.isBusy} instead.
   */
  isLoading: boolean;
  /**
   * True while a session call is in flight, whether or not the session has
   * settled. The flag for a button spinner or a disabled form, never for
   * mounting or unmounting a route.
   */
  isBusy: boolean;
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
      isLoading: !state.settled,
      isBusy: state.status === 'loading',
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
  /**
   * Called once each time the session ends, on top of whatever the client's own
   * `onSessionEnded` option does. It fires on an ordinary 401 expiry as well as
   * on a non-401 failure, and not on a startup refresh that found no cookie.
   */
  onSessionEnded?: (error: AuthSessionEndedError) => void;
  children: ReactNode;
}

/**
 * Puts an {@link AuthClient} in context, runs the silent refresh and fans the
 * session ending out to `onSessionEnded`. Safe under StrictMode's double mount,
 * since `initialize` shares one in-flight request rather than rotating the
 * cookie twice, and the fan-out is keyed on the error identity rather than on
 * the effect running.
 */
export function AuthProvider({
  client,
  initializeOnMount = true,
  onSessionEnded,
  children,
}: AuthProviderProps): ReactNode {
  const erased = client as unknown as AuthClient<unknown>;

  useEffect(() => {
    if (initializeOnMount) {
      void erased.initialize();
    }
  }, [erased, initializeOnMount]);

  return createElement(
    AuthClientContext.Provider,
    { value: erased },
    createElement(SessionEndedFanOut, { onSessionEnded }),
    children
  );
}

/**
 * Invokes `onSessionEnded` once per ending. A ref holds the last error the
 * handler saw, so StrictMode's double mount and any later re-render replay
 * nothing, and holds the latest handler so a caller need not memoise it. Its own
 * component so the subscription does not re-render the provider's children.
 */
function SessionEndedFanOut({
  onSessionEnded,
}: {
  onSessionEnded: ((error: AuthSessionEndedError) => void) | undefined;
}): ReactNode {
  const sessionEnded = useSessionEnded();
  const handler = useRef(onSessionEnded);
  handler.current = onSessionEnded;
  const notified = useRef<AuthSessionEndedError | null>(null);

  useEffect(() => {
    if (sessionEnded === null || notified.current === sessionEnded) {
      return;
    }
    notified.current = sessionEnded;
    handler.current?.(sessionEnded);
  }, [sessionEnded]);

  return null;
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

/**
 * The {@link AuthSessionEndedError} for the current ending, or null while a
 * session is live or was never started. Cleared by the next successful `login`
 * or `initialize`, so a component subscribes to the ending without prop
 * drilling and without reading `error`, which an ordinary 401 expiry leaves null.
 */
export function useSessionEnded(): AuthSessionEndedError | null {
  return useAuthState().sessionEnded;
}

/** What {@link useAuth} returns. */
export interface UseAuthResult<TUser> extends AuthState<TUser> {
  isAuthenticated: boolean;
  /**
   * True only until the session has settled once, whether that first settled
   * answer came from the silent refresh on mount or from a login. It answers
   * "is the session still unknown", so a route guard can hold a tree back on it
   * and will not unmount that tree again when a later call is in flight, which
   * would throw away a login form mid-request and lose an MFA challenge with it.
   * Gate a button spinner on {@link UseAuthResult.isBusy} instead.
   */
  isLoading: boolean;
  /**
   * True while a session call is in flight, whether or not the session has
   * settled. The flag for a button spinner or a disabled form, never for
   * mounting or unmounting a route.
   */
  isBusy: boolean;
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
  /**
   * Writes a user the caller already has into the store, with no round trip and
   * no token rotation.
   */
  setUser: AuthClient<TUser>['setUser'];
  /**
   * Re-reads the user through the client's `loadUser` hook, rotating no token. A
   * 401 ends the session the way a failed refresh does.
   */
  reloadUser: AuthClient<TUser>['reloadUser'];
  /** The in-memory access token, or null. Rarely needed in a component. */
  getAccessToken: () => string | null;
}

/** The `AuthClient` methods {@link useAuth} re-exposes, bound lazily. */
const AUTH_METHOD_NAMES = [
  'login',
  'completeTotp',
  'signInWithPasskey',
  'registerPasskey',
  'listPasskeys',
  'renamePasskey',
  'deletePasskey',
  'startOAuth',
  'logout',
  'setUser',
  'reloadUser',
  'getAccessToken',
] as const;

type AuthMethodName = (typeof AUTH_METHOD_NAMES)[number];

const boundMethods = new WeakMap<object, Map<AuthMethodName, unknown>>();

/**
 * The bound wrapper for one client method, created on first read and cached for
 * the client's lifetime, so every render hands a component the same function and
 * a method the component never reads is never touched.
 */
function boundMethod(client: object, name: AuthMethodName): unknown {
  let cache = boundMethods.get(client);
  if (cache === undefined) {
    cache = new Map();
    boundMethods.set(client, cache);
  }
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const method = (client as Record<AuthMethodName, unknown>)[name];
  if (typeof method !== 'function') {
    throw new TypeError(
      `useAuth: the auth client does not implement ${name}(). A test stub needs only the methods the component under test calls.`
    );
  }
  const wrapper = (method as (...args: unknown[]) => unknown).bind(client);
  cache.set(name, wrapper);
  return wrapper;
}

/**
 * The hook application code uses. Each method is bound on first read and cached
 * per client, so the functions stay referentially stable for the client's
 * lifetime and a client missing one only fails when that one is read.
 */
export function useAuth<TUser = unknown>(): UseAuthResult<TUser> {
  const client = useAuthClient<TUser>();
  const state = useAuthState<TUser>();

  return useMemo(() => {
    const result = {
      ...state,
      isAuthenticated: state.status === 'authenticated',
      isLoading: !state.settled,
      isBusy: state.status === 'loading',
    };
    for (const name of AUTH_METHOD_NAMES) {
      Object.defineProperty(result, name, {
        get: () => boundMethod(client, name),
        enumerable: true,
        configurable: true,
      });
    }
    return result as UseAuthResult<TUser>;
  }, [client, state]);
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
