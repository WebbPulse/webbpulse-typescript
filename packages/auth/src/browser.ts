/**
 * The lazy identity client singleton every product builds around
 * `createAuthClient`, with the origin derivation, the current-user load and the
 * two test seams that go with it.
 *
 * Framework free and a separate entry point, so a module importing the client
 * does not construct a network capable object at import time and does not pull
 * React into its bundle.
 */

import {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
} from './auth-client.js';
import type { WebAuthnAdapter } from './passkeys.js';

/**
 * What to return for a root relative base URL such as `/api`. `'empty'`, the
 * default, yields the empty string and the singleton falls back to the page's
 * own origin. `'passthrough'` returns the base URL unchanged.
 */
export type RelativeOriginMode = 'empty' | 'passthrough';

/**
 * Strips an API base URL back to its origin, since the identity routes are
 * already absolute and an `/api` base would send calls to `/api/api/auth/...`.
 * A value that is neither an absolute URL nor a root relative path is returned
 * unchanged, rather than guessed at.
 *
 * The same function `@webbpulse/discovery` exports, carried here so this
 * package does not depend on that one, which already depends on this one.
 */
export function identityOriginFrom(
  apiBaseUrl: string,
  options: { relativeAs?: RelativeOriginMode } = {}
): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    if (apiBaseUrl.startsWith('/')) {
      return options.relativeAs === 'passthrough' ? apiBaseUrl : '';
    }
    return apiBaseUrl;
  }
}

/**
 * Joins an identity origin onto an already absolute route path. An empty origin
 * yields the path alone, which the browser resolves against the current origin.
 */
export function identityUrl(origin: string, path: string): string {
  return origin === '' ? path : `${origin}${path}`;
}

/** A value read fresh on every build, or a constant. */
export type ConfigValue<T> = T | (() => T);

const resolve = <T>(value: ConfigValue<T>): T =>
  typeof value === 'function' ? (value as () => T)() : value;

/** Options for {@link createIdentityClientSingleton}. */
export interface IdentityClientSingletonOptions<TUser> {
  /**
   * The configured API base URL, such as `appConfig.apiBaseUrl`. Pass a
   * function when a test restubs the environment between cases: it is read on
   * every build rather than once at module load.
   */
  apiBaseUrl: ConfigValue<string>;
  /**
   * Where the signed in profile is read from, as a path on the identity
   * origin. Carries the `/api` prefix, because the origin is stripped back to a
   * bare one. Defaults to {@link DEFAULT_CURRENT_USER_PATH}.
   */
  currentUserPath?: string;
  /**
   * How a root relative base URL is reduced. `'empty'`, the default, yields the
   * empty string and the singleton then falls back to the page's own origin.
   * `'passthrough'` leaves it alone, for a deployment whose dev proxy needs it.
   */
  relativeAs?: RelativeOriginMode;
  /**
   * Reads the current user. Defaults to a `GET` of `currentUserPath` returning
   * `response.data ?? null`, which is what every product does.
   */
  loadUser?: AuthClientOptions<TUser>['loadUser'];
  /** `credentials` for every call. Defaults to `'include'`. */
  credentials?: RequestCredentials;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /**
   * Extra options folded into `createAuthClient`, for anything this factory
   * does not model, such as `onSessionEnded` or `paths`. `baseUrl`, `loadUser`
   * and the WebAuthn seam are this factory's own.
   */
  authClientOptions?: Omit<
    AuthClientOptions<TUser>,
    'baseUrl' | 'loadUser' | 'webAuthn'
  >;
  /**
   * Constructs the client from the resolved options. Defaults to
   * `createAuthClient`, and exists so a test can assert what was built without
   * mocking the module.
   */
  createClient?: (options: AuthClientOptions<TUser>) => AuthClient<TUser>;
}

/** Where the signed in profile is read from, unless a product says otherwise. */
export const DEFAULT_CURRENT_USER_PATH = '/api/users/me';

/** The lazy singleton and the helpers that resolve against the same origin. */
export interface IdentityClientSingleton<TUser> {
  /**
   * The identity client, or null when it could not be built. Null rather than a
   * throw, so a panel renders its own unavailable state from one code path.
   * Built on first call and cached, the failure included.
   */
  getClient: () => AuthClient<TUser> | null;
  /**
   * The origin the identity routes are mounted on, for the hooks that take an
   * origin rather than a built URL.
   */
  identityOrigin: () => string;
  /**
   * Prefixes the identity origin onto an already absolute route path, for the
   * discovery gates that fetch directly instead of through the client.
   */
  identityUrl: (path: string) => string;
  /** Where the signed in profile is read from. */
  currentUserPath: string;
  /**
   * Installs a WebAuthn stub for the passkey tests. Tests only, and must run
   * before the first `getClient()`, since `AuthClient` fixes the adapter at
   * construction.
   */
  setWebAuthnAdapterForTests: (adapter: WebAuthnAdapter | null) => void;
  /**
   * Disposes and drops the cached instance, and clears the adapter seam. Tests
   * only, and preferable to `vi.resetModules`, which would also drop whatever
   * else the importing module holds.
   */
  resetForTests: () => void;
}

/**
 * Builds the lazy identity client singleton, so a product's `identityClient`
 * module is a configuration call plus its own re-exports.
 *
 * The client is constructed on the first `getClient()` rather than at import
 * time, and `apiBaseUrl` is read at that moment, so a test that stubs the
 * environment and then calls `resetForTests()` gets a client built from the new
 * value. An origin that reduces to the empty string falls back to the page's
 * own origin, which is what a root relative base behind a dev proxy wants.
 *
 * @example
 * ```ts
 * const identity = createIdentityClientSingleton<UserRead>({
 *   apiBaseUrl: () => appConfig.apiBaseUrl,
 * });
 *
 * export const getIdentityClient = identity.getClient;
 * export const identityUrl = identity.identityUrl;
 * export const resetIdentityClientForTests = identity.resetForTests;
 * ```
 */
export function createIdentityClientSingleton<TUser>(
  options: IdentityClientSingletonOptions<TUser>
): IdentityClientSingleton<TUser> {
  const currentUserPath = options.currentUserPath ?? DEFAULT_CURRENT_USER_PATH;

  let client: AuthClient<TUser> | null = null;
  let built = false;
  let webAuthnAdapter: WebAuthnAdapter | null = null;

  const identityOrigin = (): string =>
    identityOriginFrom(
      resolve(options.apiBaseUrl),
      options.relativeAs === undefined ? {} : { relativeAs: options.relativeAs }
    );

  const loadUser: NonNullable<AuthClientOptions<TUser>['loadUser']> =
    options.loadUser ??
    ((apiClient) =>
      apiClient
        .get<TUser>(currentUserPath)
        .then((response) => response.data ?? null));

  return {
    getClient: (): AuthClient<TUser> | null => {
      if (built) return client;
      built = true;
      const origin = identityOrigin();
      const build = options.createClient ?? createAuthClient<TUser>;
      client = build({
        ...options.authClientOptions,
        baseUrl: origin === '' ? globalThis.location.origin : origin,
        loadUser,
        clientOptions: {
          credentials: options.credentials ?? 'include',
          timeoutMs: options.timeoutMs ?? 30000,
          ...options.authClientOptions?.clientOptions,
        },
        ...(webAuthnAdapter === null ? {} : { webAuthn: webAuthnAdapter }),
      });
      return client;
    },
    identityOrigin,
    identityUrl: (path: string): string => identityUrl(identityOrigin(), path),
    currentUserPath,
    setWebAuthnAdapterForTests: (adapter: WebAuthnAdapter | null): void => {
      webAuthnAdapter = adapter;
    },
    resetForTests: (): void => {
      client?.dispose();
      client = null;
      built = false;
      webAuthnAdapter = null;
    },
  };
}
