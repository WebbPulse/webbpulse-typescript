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
  type PasskeySignInOutcome,
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
  /**
   * Re-authenticates for a fresher access token with a TOTP or recovery code,
   * for a component gating a sensitive action on freshness rather than on a
   * session.
   */
  stepUp: AuthClient<TUser>['stepUp'];
  /**
   * The same step-up run against a passkey instead of a code. An account with
   * no passkey answers `no-passkeys`, which is the cue to fall back to
   * {@link UseAuthResult.stepUp}.
   */
  stepUpWithPasskey: AuthClient<TUser>['stepUpWithPasskey'];
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
  'stepUp',
  'stepUpWithPasskey',
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

/** What {@link usePasskeySignInButton} is showing and offers to run. */
export interface PasskeySignInButton {
  /**
   * Whether to render the control at all. False when there is no client, the
   * browser does no WebAuthn, or the deployment has passwordless sign-in off.
   */
  offered: boolean;
  /** True while a click-driven ceremony is outstanding. Gate the label on it. */
  busy: boolean;
  /** Whether the browser can put a passkey in its autofill dropdown. */
  conditional: boolean;
  /**
   * Runs an `optional` ceremony, reporting every outcome but a cancellation and
   * a browser that will not run it. Never rejects: a thrown ceremony clears
   * `busy` and reports nothing, so a click handler that does not await it leaks
   * no unhandled rejection.
   */
  signIn: () => Promise<void>;
}

/** Options for {@link usePasskeySignInButton}. */
export interface PasskeySignInButtonOptions {
  /** The client to run the ceremony on. Null answers `offered: false`. */
  client: Pick<AuthClient<never>, 'signInWithPasskey'> | null;
  /**
   * Answers whether this deployment offers passwordless sign-in. Pass
   * `@webbpulse/discovery`'s `passkeyLoginAvailability`, bound to the identity
   * URL. Read through a ref, so it need not be memoised.
   */
  probe: () => Promise<'available' | 'unavailable' | 'unknown'>;
  /**
   * The address already in the form, so a known user skips the chooser. Blank
   * or omitted runs the discoverable flow.
   */
  email?: string;
  /**
   * Called for every outcome except a cancellation or a browser that will not
   * run the ceremony, both silent because neither is a failure to report.
   */
  onResult: (result: PasskeySignInOutcome) => void | Promise<void>;
  /**
   * Called when the ceremony itself throws, which the client reserves for a
   * network failure or a server error it could not turn into an outcome.
   * Omitted, `signIn` rejects with that error, so nothing is swallowed.
   */
  onError?: (error: unknown) => void;
  /**
   * Whether to arm conditional mediation on mount. Defaults to true; pass false
   * in a test, where an autofill ceremony has nothing to talk to.
   */
  conditional?: boolean;
}

/**
 * The passkey sign-in button, headless: whether to draw it, whether a ceremony
 * is running, and the click handler. No markup, so a product keeps its own.
 *
 * Conditional mediation is armed in an effect once the deployment and the
 * browser both say yes, and torn down through an `AbortController` on cleanup,
 * so a ceremony does not outlive the page that started it. Its result is
 * dropped when the signal aborted, since a torn-down ceremony reports a
 * cancellation the caller never asked for. A browser that accepts the autofill
 * probe and then refuses the request answers `unsupported`, which is dropped
 * for the same reason. `onResult` is read through a ref, so a handler redefined
 * on every render does not restart the ceremony.
 *
 * @example
 * ```tsx
 * const button = usePasskeySignInButton({ client, probe, email, onResult });
 * if (!button.offered) return null;
 * return (
 *   <Button onClick={() => void button.signIn()} disabled={button.busy}>
 *     {button.busy ? 'Waiting for your passkey' : 'Sign in with a passkey'}
 *   </Button>
 * );
 * ```
 */
export function usePasskeySignInButton(
  options: PasskeySignInButtonOptions
): PasskeySignInButton {
  const { client, email, conditional = true } = options;
  const [busy, setBusy] = useState(false);

  const handler = useRef(options.onResult);
  handler.current = options.onResult;
  const errorHandler = useRef(options.onError);
  errorHandler.current = options.onError;

  const probe = useRef(options.probe);
  probe.current = options.probe;

  const stableProbe = useCallback(() => probe.current(), []);
  const support = usePasskeySignInSupport({
    probe: stableProbe,
    enabled: client !== null,
  });

  const armed = conditional && support.conditional && client !== null;

  useEffect(() => {
    if (!armed || client === null) return;
    const controller = new AbortController();

    void client
      .signInWithPasskey({
        mediation: 'conditional',
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) return;
        void handler.current(result);
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
    };
  }, [armed, client]);

  const signIn = useCallback(async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      const trimmed = email?.trim() ?? '';
      const result = await client.signInWithPasskey(
        trimmed === ''
          ? { mediation: 'optional' }
          : { email: trimmed, mediation: 'optional' }
      );
      if (
        !result.ok &&
        (result.reason === 'cancelled' || result.reason === 'unsupported')
      ) {
        return;
      }
      await handler.current(result);
    } catch (error) {
      if (errorHandler.current === undefined) throw error;
      errorHandler.current(error);
    } finally {
      setBusy(false);
    }
  }, [client, email]);

  return {
    offered: client !== null && support.offered,
    busy,
    conditional: support.conditional,
    signIn,
  };
}

/** One provider's button, as {@link useOAuthProviderLinks} reports it. */
export interface OAuthProviderLink {
  /** The provider id, `google` or `github` in the baseline. Use as the key. */
  id: string;
  /** The name to show a user, as the deployment reported it. */
  displayName: string;
  /**
   * Where the anchor points. A real navigation, because the start route
   * redirects to a host that sends no CORS headers.
   */
  href: string;
}

/** Options for {@link useOAuthProviderLinks}. */
export interface OAuthProviderLinksOptions {
  /** The client that builds the start URLs. Null answers an empty list. */
  client: Pick<AuthClient<never>, 'oauthStartUrl'> | null;
  /** The providers the deployment reported, from `useOAuthProviders`. */
  providers: readonly { id: string; displayName: string }[];
  /** Where to land after the callback, as a path on this frontend. */
  returnTo?: string;
}

/**
 * The "Continue with X" links, one per provider the deployment offers, with the
 * start URL already built. State only, so a product keeps its own anchors,
 * icons and copy.
 *
 * An empty array is the one signal a caller needs to render nothing: no client
 * and no providers both reduce to it.
 *
 * @example
 * ```tsx
 * const providers = useOAuthProviders({ identityOrigin });
 * const links = useOAuthProviderLinks({ client, providers, returnTo });
 * return links.map((link) => (
 *   <a key={link.id} href={link.href}>Continue with {link.displayName}</a>
 * ));
 * ```
 */
export function useOAuthProviderLinks(
  options: OAuthProviderLinksOptions
): OAuthProviderLink[] {
  const { client, providers, returnTo } = options;

  return useMemo(() => {
    if (client === null) return [];
    return providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      href: client.oauthStartUrl(
        provider.id,
        returnTo === undefined ? {} : { returnTo }
      ),
    }));
  }, [client, providers, returnTo]);
}

/** The prefix every {@link useDismissedUntilSignIn} key is stored under. */
export const DISMISSAL_STORAGE_PREFIX = 'webbpulse.dismissed.';

const memoryDismissals = new Set<string>();

/**
 * The tab's session storage, or null where reading the property itself throws,
 * as it does with site data blocked or in a sandboxed frame.
 */
function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Whether the flag is set in storage or, where storage refused the write, in the
 * in-memory fallback that keeps a dismissal for the page's lifetime in a privacy
 * mode rather than failing the render.
 */
function readDismissal(storageKey: string): boolean {
  try {
    if (tabStorage()?.getItem(storageKey) === '1') {
      return true;
    }
  } catch {
    return memoryDismissals.has(storageKey);
  }
  return memoryDismissals.has(storageKey);
}

/**
 * Records the flag in storage, falling back to memory when storage is missing
 * or throws, or clears it from both.
 */
function writeDismissal(storageKey: string, dismissed: boolean): void {
  if (!dismissed) {
    memoryDismissals.delete(storageKey);
  }
  try {
    const storage = tabStorage();
    if (storage === null) {
      if (dismissed) {
        memoryDismissals.add(storageKey);
      }
      return;
    }
    if (dismissed) {
      storage.setItem(storageKey, '1');
    } else {
      storage.removeItem(storageKey);
    }
  } catch {
    if (dismissed) {
      memoryDismissals.add(storageKey);
    }
  }
}

/** What {@link useDismissedUntilSignIn} returns. */
export interface DismissedUntilSignIn {
  /** Whether the notice was dismissed during the current signed in session. */
  dismissed: boolean;
  /** Hides the notice until the next sign-in in this tab. */
  dismiss: () => void;
}

/**
 * A dismissal that lasts until the next sign-in, for a notice such as an "in
 * development" banner that should greet every new session without nagging on
 * each page load inside one.
 *
 * The flag lives in session storage under {@link DISMISSAL_STORAGE_PREFIX} plus
 * `key`, so it is per tab: a reload keeps it and a new tab starts without it.
 * It is cleared whenever the session settles signed out, whether on the first
 * settle of a page load or after a sign-out or an expiry, and never while the
 * session is still unknown, so the next sign-in shows the notice again. Storage
 * that throws falls back to memory for the page's lifetime. Headless: the
 * application draws the notice.
 *
 * @example
 * ```tsx
 * const { dismissed, dismiss } = useDismissedUntilSignIn('dev-banner');
 * if (dismissed) return null;
 * return <Banner onClose={dismiss} />;
 * ```
 */
export function useDismissedUntilSignIn(key: string): DismissedUntilSignIn {
  const storageKey = `${DISMISSAL_STORAGE_PREFIX}${key}`;
  const state = useAuthState();
  const signedOut =
    state.settled &&
    state.status !== 'authenticated' &&
    !(state.status === 'loading' && state.hasAccessToken);
  const [dismissed, setDismissed] = useState(() => readDismissal(storageKey));

  useEffect(() => {
    if (!signedOut) {
      return;
    }
    writeDismissal(storageKey, false);
    setDismissed(false);
  }, [signedOut, storageKey]);

  const dismiss = useCallback(() => {
    writeDismissal(storageKey, true);
    setDismissed(true);
  }, [storageKey]);

  return { dismissed: dismissed && !signedOut, dismiss };
}
