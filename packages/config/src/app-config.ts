import { ConfigReader, type ViteEnv } from './env.js';

/** Deployment environments in the estate. */
export const ENVIRONMENT_NAMES = ['local', 'staging', 'production'] as const;

export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** The resolved configuration an application holds for its lifetime. */
export interface AppConfig {
  /** Which deployment this bundle is for. */
  environment: EnvironmentName;
  /**
   * Single origin for the whole API. The backend routes by path prefix to one
   * Lambda per domain behind one HTTP API, so a domain split never adds a
   * second base URL here.
   */
  apiBaseUrl: string;
  /** True when running under the Vite dev server. */
  isDev: boolean;
  /** True for a production build, regardless of which backend it targets. */
  isProd: boolean;
  /** Application name, for logging and document titles. */
  appName: string;
  /** Release identifier, when the build injected one. */
  release: string | undefined;
}

/** Options for {@link loadAppConfig}. */
export interface LoadAppConfigOptions {
  /**
   * Fallback API base URL when `VITE_API_BASE_URL` is unset.
   *
   * There is deliberately no built in default here. Portfolio's
   * `services/api.ts` hardcodes `http://localhost:8000/api/v1` and its
   * `vite.config.ts` hardcodes `http://localhost:8000` a second time, which is
   * exactly the pattern this package exists to remove. An application that
   * wants a local default states it at the call site, where it is visible.
   */
  defaultApiBaseUrl?: string;
  /** Application name when `VITE_APP_NAME` is unset. */
  defaultAppName?: string;
  /**
   * Dev only backend switch: a map from the value of `VITE_BACKEND` to the
   * base URL that value selects.
   *
   * CarModPicker runs `npm run dev:staging` and `npm run dev:prod`, which set
   * `VITE_BACKEND=staging` and `VITE_BACKEND=production` so the local dev
   * server talks to a deployed backend instead of localhost. Without this the
   * application has to resolve the URL itself before calling `loadAppConfig`,
   * which puts the one piece of URL selection outside the validating layer.
   *
   * Consulted **only when `DEV` is true**. A production bundle reads
   * `VITE_API_BASE_URL` as it always did, so a stray `VITE_BACKEND` in a deploy
   * environment cannot repoint a shipped build at another backend. That is the
   * property worth having: the switch is a developer convenience, and a
   * convenience that survives into production is a way to ship the wrong URL.
   *
   * A value present in the map wins over `VITE_API_BASE_URL`, since a developer
   * who asked for the staging backend means it. A value absent from the map,
   * and an unset `VITE_BACKEND`, both fall through to the normal resolution, so
   * `{ staging, production }` leaves the default local flow untouched.
   *
   * Each URL is validated the same way `VITE_API_BASE_URL` is, so a typo in the
   * map throws at startup rather than at the first request.
   *
   * @example
   * ```ts
   * loadAppConfig(import.meta.env, {
   *   defaultApiBaseUrl: '/api',
   *   backendTargets: {
   *     staging: env.VITE_STAGING_API_URL,
   *     production: env.VITE_PROD_API_URL,
   *   },
   *   apiPathPrefix: '/api',
   * });
   * ```
   */
  backendTargets?: Record<string, string | undefined>;
  /**
   * Path suffix appended to the resolved base URL.
   *
   * The backends mount every router under one prefix (`/api` for CarModPicker),
   * and the deploy writes the bare origin into `VITE_API_URL` because that is
   * what the Terraform `api_url` output is. Somebody has to join the two, and
   * doing it here means the joined value is what gets validated rather than the
   * half of it that was in the environment.
   *
   * Applied after the base URL is resolved and its trailing slashes are
   * stripped, and skipped when the resolved URL already ends with the prefix,
   * so a `VITE_API_BASE_URL` that was written with the prefix in it does not
   * become `/api/api`. That idempotence matters because the two applications
   * disagree today about whether the variable holds the origin or the full base,
   * and both spellings are in deploy configuration right now.
   */
  apiPathPrefix?: string;
  /**
   * Name of the environment variable {@link backendTargets} is keyed by.
   *
   * Defaults to `VITE_BACKEND`, which is the name CarModPicker's dev scripts
   * already set. Exposed so an application that spells it differently does not
   * have to rename its scripts to adopt this.
   */
  backendTargetKey?: string;
}

/**
 * Maps a Vite mode onto an environment name.
 *
 * `import.meta.env.MODE` is whatever `--mode` was passed, so it can be
 * `development`, `production`, `staging` or something bespoke. This normalises
 * the common spellings and leaves anything else to explicit configuration
 * through `VITE_ENVIRONMENT`.
 */
function environmentFromMode(
  mode: string | undefined
): EnvironmentName | undefined {
  switch (mode) {
    case 'development':
    case 'local':
      return 'local';
    case 'staging':
      return 'staging';
    case 'production':
      return 'production';
    default:
      return undefined;
  }
}

/**
 * Resolves the dev backend switch to a URL and the key that named it.
 *
 * Returns `undefined` when the switch is unset, blank, or names a target the
 * map does not carry, in which case the caller falls through to the normal
 * `VITE_API_BASE_URL` resolution. A map entry whose value is `undefined` is
 * treated as absent too, so a caller can pass `env.VITE_STAGING_API_URL`
 * straight through without guarding it first.
 *
 * The returned `key` is the environment variable that supplied the URL, so a
 * validation failure reports the name a developer would go and fix rather than
 * `VITE_BACKEND`, which merely selected it.
 */
function readBackendTarget(
  env: ViteEnv,
  targets: Record<string, string | undefined>,
  switchKey: string
): { key: string; url: string } | undefined {
  const raw = env[switchKey];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const selected = raw.trim().toLowerCase();
  if (selected === '') {
    return undefined;
  }
  const url = Object.prototype.hasOwnProperty.call(targets, selected)
    ? targets[selected]
    : undefined;
  if (typeof url !== 'string' || url.trim() === '') {
    return undefined;
  }
  return { key: `${switchKey}=${selected}`, url: url.trim() };
}

/** Strips every trailing slash, collapsing a bare "/" to itself. */
function stripTrailingSlashes(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Appends the path prefix unless it is already there.
 *
 * The idempotence check is on the resolved URL's path, not on the whole string,
 * so `https://api.example.com/api` and `/api` are both recognised while a host
 * that merely ends in the same characters is not.
 */
function applyPathPrefix(baseUrl: string, prefix: string): string {
  const normalisedPrefix = stripTrailingSlashes(
    prefix.startsWith('/') ? prefix : `/${prefix}`
  );
  if (normalisedPrefix === '/') {
    return baseUrl;
  }
  const stripped = stripTrailingSlashes(baseUrl);
  const path = stripped.startsWith('/')
    ? stripped
    : (() => {
        try {
          return stripTrailingSlashes(new URL(stripped).pathname);
        } catch {
          // Not parseable as a URL. The reader reports that separately; here
          // the safe move is to leave the value exactly as it arrived so the
          // error message names what the caller actually set.
          return null;
        }
      })();
  if (path === null) {
    return baseUrl;
  }
  if (path === normalisedPrefix || path.endsWith(normalisedPrefix)) {
    return stripped;
  }
  return `${stripped === '/' ? '' : stripped}${normalisedPrefix}`;
}

/**
 * Reads and validates configuration from a Vite environment bag.
 *
 * Call it once at startup, before rendering. It throws `ConfigError` listing
 * every problem rather than failing later at the first request with an opaque
 * network error against an `undefined` URL.
 *
 * @example
 * ```ts
 * const config = loadAppConfig(import.meta.env, {
 *   defaultApiBaseUrl: '/api',
 *   defaultAppName: 'CarModPicker',
 * });
 * ```
 */
export function loadAppConfig(
  env: ViteEnv,
  options: LoadAppConfigOptions = {}
): AppConfig {
  const reader = new ConfigReader(env);

  const inferred = environmentFromMode(
    typeof env.MODE === 'string' ? env.MODE : undefined
  );
  const environment = reader.oneOf(
    'VITE_ENVIRONMENT',
    ENVIRONMENT_NAMES,
    inferred ?? 'local'
  );

  // The dev only backend switch, consulted before VITE_API_BASE_URL. A
  // production bundle never reaches this branch, so a stray VITE_BACKEND in a
  // deploy environment cannot repoint a shipped build.
  const backendTarget =
    env.DEV === true && options.backendTargets !== undefined
      ? readBackendTarget(
          env,
          options.backendTargets,
          options.backendTargetKey ?? 'VITE_BACKEND'
        )
      : undefined;

  const resolvedBaseUrl =
    backendTarget === undefined
      ? reader.url('VITE_API_BASE_URL', {
          ...(options.defaultApiBaseUrl === undefined
            ? {}
            : { fallback: options.defaultApiBaseUrl }),
        })
      : // Validated through the same reader, under the key that selected it, so
        // a malformed entry in the map names itself in the error.
        reader.url(backendTarget.key, { fallback: backendTarget.url });

  const apiBaseUrl =
    options.apiPathPrefix === undefined || resolvedBaseUrl === ''
      ? resolvedBaseUrl
      : applyPathPrefix(resolvedBaseUrl, options.apiPathPrefix);

  const appName = reader.optionalString(
    'VITE_APP_NAME',
    options.defaultAppName ?? 'WebbPulse'
  );

  const release = reader.optionalString('VITE_RELEASE', '');

  reader.assertValid();

  return {
    environment,
    apiBaseUrl,
    isDev: env.DEV === true,
    isProd: env.PROD === true,
    appName,
    release: release === '' ? undefined : release,
  };
}
