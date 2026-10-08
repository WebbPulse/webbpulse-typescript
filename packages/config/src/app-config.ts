import { ConfigReader, type ViteEnv } from './env.js';

/** Deployment environments in the estate. */
export const ENVIRONMENT_NAMES = ['local', 'staging', 'production'] as const;

/** One of {@link ENVIRONMENT_NAMES}. */
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** The resolved configuration an application holds for its lifetime. */
export interface AppConfig {
  /** Which deployment this bundle is for. */
  environment: EnvironmentName;
  /** Single origin for the whole API. The backend routes by path prefix. */
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
   * Fallback API base URL when `VITE_API_BASE_URL` is unset. There is no built
   * in default: an application that wants one states it at the call site.
   */
  defaultApiBaseUrl?: string;
  /** Application name when `VITE_APP_NAME` is unset. */
  defaultAppName?: string;
  /**
   * Map from `VITE_BACKEND` to the base URL it selects, so a dev server can
   * point at a deployed backend. Consulted only when `DEV` is true, so it
   * cannot repoint a shipped bundle; a match wins over `VITE_API_BASE_URL`.
   */
  backendTargets?: Record<string, string | undefined>;
  /**
   * Path suffix appended to the resolved base URL, so the joined value is what
   * gets validated. Idempotent: a base that already ends with the prefix is
   * left alone, because both spellings are in deploy configuration today.
   */
  apiPathPrefix?: string;
  /**
   * Name of the environment variable {@link backendTargets} is keyed by.
   * Defaults to `VITE_BACKEND`.
   */
  backendTargetKey?: string;
  /**
   * Further variable names read, in order, when `VITE_API_BASE_URL` is unset
   * or blank, for a deployment that writes the base URL under another name
   * such as `VITE_API_URL`. A failure reports the name that was read.
   */
  apiBaseUrlAliases?: readonly string[];
  /**
   * Prefixes `https://` onto an API base URL or backend target written as a
   * bare host, such as `api.example.com`, which some deploys emit. Off by
   * default, so a bare host stays a validation error.
   */
  assumeHttps?: boolean;
}

/**
 * Maps a Vite mode onto an environment name, normalising the common spellings
 * and leaving anything else to an explicit `VITE_ENVIRONMENT`.
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
 * Resolves the dev backend switch to a URL and the key that named it, or
 * `undefined` when nothing matched, so the caller falls through to the normal
 * resolution. The key names the variable a validation failure should report.
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

/** Whether `value` is a string with something other than whitespace in it. */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Prefixes `https://` onto a bare host, leaving a root relative path and a
 * value that already names a scheme alone.
 */
function withHttps(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}

/**
 * The environment with the API base URL read under its first filled name, and
 * with bare hosts given a scheme when asked, plus the name that was read.
 */
function normaliseBaseUrlEnv(
  env: ViteEnv,
  options: LoadAppConfigOptions
): { env: ViteEnv; key: string } {
  const keys = ['VITE_API_BASE_URL', ...(options.apiBaseUrlAliases ?? [])];
  const key = keys.find((name) => isFilled(env[name])) ?? 'VITE_API_BASE_URL';
  const value = env[key];
  if (options.assumeHttps !== true || !isFilled(value)) {
    return { env, key };
  }
  return { env: { ...env, [key]: withHttps(value) }, key };
}

/** Strips every trailing slash, collapsing a bare "/" to itself. */
function stripTrailingSlashes(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Appends the path prefix unless it is already there. The check is on the
 * resolved URL's path, so a host merely ending in the same characters misses.
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
 * Reads and validates configuration from a Vite environment bag. Call it once
 * at startup: it throws `ConfigError` listing every problem it found.
 */
export function loadAppConfig(
  env: ViteEnv,
  options: LoadAppConfigOptions = {}
): AppConfig {
  const { env: normalisedEnv, key: baseUrlKey } = normaliseBaseUrlEnv(
    env,
    options
  );
  const reader = new ConfigReader(normalisedEnv);

  const inferred = environmentFromMode(
    typeof env.MODE === 'string' ? env.MODE : undefined
  );
  const environment = reader.oneOf(
    'VITE_ENVIRONMENT',
    ENVIRONMENT_NAMES,
    inferred ?? 'local'
  );

  const rawBackendTarget =
    env.DEV === true && options.backendTargets !== undefined
      ? readBackendTarget(
          env,
          options.backendTargets,
          options.backendTargetKey ?? 'VITE_BACKEND'
        )
      : undefined;
  const backendTarget =
    rawBackendTarget !== undefined && options.assumeHttps === true
      ? { ...rawBackendTarget, url: withHttps(rawBackendTarget.url) }
      : rawBackendTarget;

  const resolvedBaseUrl =
    backendTarget === undefined
      ? reader.url(baseUrlKey, {
          ...(options.defaultApiBaseUrl === undefined
            ? {}
            : { fallback: options.defaultApiBaseUrl }),
        })
      : reader.url(backendTarget.key, { fallback: backendTarget.url });

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
