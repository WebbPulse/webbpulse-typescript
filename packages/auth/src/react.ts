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
export function useSessionManager<TUser = unknown, TCredentials = unknown>(): SessionManager<
  TUser,
  TCredentials
> {
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
export interface UseSessionResult<TUser, TCredentials>
  extends SessionState<TUser> {
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
