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
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AuthClient, AuthState } from './auth-client.js';
import {
  readLinkToken,
  VERIFY_EMAIL_PATH,
  type LinkRefused,
} from './email-flows.js';
import type { AuthSessionEndedError } from './errors.js';
import {
  conditionalMediationAvailable,
  passkeysSupported,
} from './passkeys.js';
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
 *
 * @deprecated Use {@link AnyAuthClient} instead. Removed in the next major.
 */
export type AnySessionManager = SessionManager<never, never>;

/**
 * Props for {@link SessionProvider}.
 *
 * @deprecated Use {@link AuthProviderProps} instead. Removed in the next major.
 */
export interface SessionProviderProps {
  /** The manager to expose. Construct it once, outside the component tree. */
  manager: AnySessionManager;
  /** Fetches the current user on mount. Defaults to true. */
  refreshOnMount?: boolean;
  children: ReactNode;
}

/**
 * Puts a `SessionManager` in context.
 *
 * @deprecated Use {@link AuthProvider} instead. Removed in the next major.
 */
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

/**
 * Returns the manager from context. Throws outside a provider.
 *
 * @deprecated Use {@link useAuthClient} instead. Removed in the next major.
 */
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
 *
 * @deprecated Use {@link useAuthState} instead. Removed in the next major.
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

/**
 * What {@link useSession} returns.
 *
 * @deprecated Use {@link UseAuthResult} instead. Removed in the next major.
 */
export interface UseSessionResult<
  TUser,
  TCredentials,
> extends SessionState<TUser> {
  /**
   * Whether a session is held. True while a call is in flight on a session that
   * already had a user, since a guard redirecting on `!isAuthenticated` would
   * otherwise eject a signed in user for the duration of every later call.
   */
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

/**
 * The hook application code uses for session state and the session flows.
 *
 * @deprecated Use {@link useAuth} instead, which adds the passkey, OAuth, TOTP
 * and email flows. Removed in the next major.
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
      isAuthenticated:
        state.status === 'authenticated' ||
        (state.status === 'loading' && state.hadUser),
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
  /**
   * Whether a session is held. True while a token call is in flight on an
   * already authenticated session, since the token outlives the `'loading'`
   * status the call passes through. Without that a guard redirecting on
   * `!isAuthenticated` would eject a signed in user on every later token call.
   */
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
      isAuthenticated:
        state.status === 'authenticated' ||
        (state.status === 'loading' && state.hasAccessToken),
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

/** What a browser and a deployment together allow on a sign-in page. */
export interface PasskeySignInSupport {
  /**
   * Whether to render the button at all. True only when the browser does
   * WebAuthn and the deployment answered that passwordless sign-in is on.
   */
  offered: boolean;
  /**
   * Whether to arm a conditional ceremony against the username field, which
   * puts a passkey in the browser's autofill dropdown.
   */
  conditional: boolean;
}

/** Options for {@link usePasskeySignInSupport}. */
export interface PasskeySignInSupportOptions {
  /**
   * Answers whether this deployment offers passwordless sign-in. Pass
   * `@webbpulse/discovery`'s `passkeyLoginAvailability`, bound to the identity
   * URL, so this package needs no knowledge of the discovery routes.
   */
  probe: () => Promise<'available' | 'unavailable' | 'unknown'>;
  /** Whether to ask at all. False answers no without a request. */
  enabled?: boolean;
}

/**
 * Whether to offer a passkey sign-in button, and whether the browser can put a
 * passkey in its autofill dropdown.
 *
 * The two questions are asked in order and conditional mediation only after the
 * deployment says yes, so a deployment with passwordless off costs one read and
 * no capability probe. Only an `available` answer offers the button: a route
 * that could not be read is not a deployment with the capability switched off.
 *
 * @example
 * ```ts
 * const { offered, conditional } = usePasskeySignInSupport({
 *   probe: () => passkeyLoginAvailability(identityUrl(origin, PASSKEY_AVAILABILITY_PATH)),
 * });
 * ```
 */
export function usePasskeySignInSupport(
  options: PasskeySignInSupportOptions
): PasskeySignInSupport {
  const [support, setSupport] = useState<PasskeySignInSupport>({
    offered: false,
    conditional: false,
  });
  const probe = useRef(options.probe);
  probe.current = options.probe;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled || !passkeysSupported()) {
      setSupport({ offered: false, conditional: false });
      return;
    }
    let live = true;

    void (async () => {
      const availability = await probe.current();
      if (!live) {
        return;
      }
      if (availability !== 'available') {
        setSupport({ offered: false, conditional: false });
        return;
      }
      const conditional = await conditionalMediationAvailable();
      if (!live) {
        return;
      }
      setSupport({ offered: true, conditional });
    })();

    return () => {
      live = false;
    };
  }, [enabled]);

  return support;
}

/** What {@link useEmailVerificationLink} is showing. */
export type EmailVerificationLinkState =
  | { kind: 'confirming' }
  | { kind: 'confirmed' }
  | { kind: 'missing-token' }
  | { kind: 'refused'; reason: LinkRefused['reason']; message: string }
  | { kind: 'failed' };

/** Options for {@link useEmailVerificationLink}. */
export interface EmailVerificationLinkOptions {
  /** The client to confirm with. Null reports `failed` without a request. */
  client: AuthClient<unknown> | null;
  /**
   * The path the link lands on, so a token meant for another flow is not spent
   * here. Defaults to {@link VERIFY_EMAIL_PATH}.
   */
  expectedPath?: string;
  /** The URL to read the token from. Defaults to the current location. */
  url?: string;
  /** Called once after a confirmed address, to re-read the user record. */
  onConfirmed?: () => void | Promise<void>;
}

/**
 * Spends a mailed verification token exactly once on mount and reports the
 * outcome, leaving every sentence to the caller.
 *
 * The token is single use, so a ref guards the effect against the double
 * invocation StrictMode performs in development: without it a valid link is
 * spent by the first call and the second reports it as already used. A thrown
 * request reports `failed` rather than rejecting, since a landing page has
 * nowhere to catch.
 *
 * @example
 * ```tsx
 * const state = useEmailVerificationLink({ client, onConfirmed: checkAuthStatus });
 * if (state.kind === 'refused') return <Alert message={state.message} />;
 * ```
 */
export function useEmailVerificationLink(
  options: EmailVerificationLinkOptions
): EmailVerificationLinkState {
  const [state, setState] = useState<EmailVerificationLinkState>({
    kind: 'confirming',
  });
  const spent = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (spent.current) {
      return;
    }
    spent.current = true;

    const { client, expectedPath, url, onConfirmed } = latest.current;
    if (client === null) {
      setState({ kind: 'failed' });
      return;
    }
    const token = readLinkToken({
      expectedPath: expectedPath ?? VERIFY_EMAIL_PATH,
      ...(url === undefined ? {} : { url }),
    });
    if (token === null) {
      setState({ kind: 'missing-token' });
      return;
    }

    void (async () => {
      try {
        const outcome = await client.confirmEmailVerification({ token });
        if (outcome.ok) {
          setState({ kind: 'confirmed' });
          await onConfirmed?.();
          return;
        }
        setState({
          kind: 'refused',
          reason: outcome.reason,
          message: outcome.message,
        });
      } catch {
        setState({ kind: 'failed' });
      }
    })();
  }, []);

  return state;
}

/**
 * The token waiter a polled query takes. Structural rather than an import of
 * `AuthTokenProvider`, so the shape stays the contract and neither package has
 * to widen its dependencies for it.
 */
export interface QueryAuth {
  /** Resolves once the first refresh of the page load has settled. */
  waitForToken(): Promise<string | null>;
}

/**
 * The `auth` option for `usePolledQuery`, bound to the client from context.
 *
 * Without it every adopter writes the same adapter, and the one that forgets
 * ships a query that mounts during boot, goes out anonymous and renders a 401.
 * The result is referentially stable for the client's lifetime, so passing it
 * straight into a query's options does not restart the poll on every render.
 *
 * @example
 * ```ts
 * const auth = useQueryAuth();
 * const { data } = usePolledQuery(
 *   ({ signal }) => listJobs(signal),
 *   { queryKey: 'jobs', auth }
 * );
 * ```
 */
export function useQueryAuth(): QueryAuth {
  const client = useAuthClient();
  return useMemo(
    () => ({ waitForToken: () => client.waitForToken() }),
    [client]
  );
}
