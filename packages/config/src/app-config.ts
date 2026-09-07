import { ConfigReader, type ViteEnv } from './env.js';

/** Deployment environments in the estate. */
export const ENVIRONMENT_NAMES = [
  'local',
  'staging',
  'production',
] as const;

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
}

/**
 * Maps a Vite mode onto an environment name.
 *
 * `import.meta.env.MODE` is whatever `--mode` was passed, so it can be
 * `development`, `production`, `staging` or something bespoke. This normalises
 * the common spellings and leaves anything else to explicit configuration
 * through `VITE_ENVIRONMENT`.
 */
function environmentFromMode(mode: string | undefined): EnvironmentName | undefined {
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

  const apiBaseUrl = reader.url('VITE_API_BASE_URL', {
    ...(options.defaultApiBaseUrl === undefined
      ? {}
      : { fallback: options.defaultApiBaseUrl }),
  });

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
