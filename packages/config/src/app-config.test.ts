import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './app-config.js';
import { ConfigError } from './env.js';

describe('loadAppConfig', () => {
  it('reads a fully specified environment', () => {
    const config = loadAppConfig({
      MODE: 'production',
      PROD: true,
      DEV: false,
      VITE_ENVIRONMENT: 'production',
      VITE_API_BASE_URL: 'https://api.carmodpicker.com',
      VITE_APP_NAME: 'CarModPicker',
      VITE_RELEASE: 'abc123',
    });

    expect(config).toEqual({
      environment: 'production',
      apiBaseUrl: 'https://api.carmodpicker.com',
      isDev: false,
      isProd: true,
      appName: 'CarModPicker',
      release: 'abc123',
    });
  });

  it('throws listing every problem at once', () => {
    // Startup should report the whole set, not send the reader round the loop
    // one missing variable at a time.
    let caught: unknown;
    try {
      loadAppConfig({ VITE_ENVIRONMENT: 'qa', VITE_API_BASE_URL: 'not a url' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toHaveLength(2);
  });

  it('fails when the API base URL is absent and no default is given', () => {
    // Deliberately no built in default: Portfolio hardcoding localhost:8000 in
    // two places is the exact pattern this package exists to remove.
    expect(() => loadAppConfig({ MODE: 'production' })).toThrow(ConfigError);
  });

  it('accepts a root relative API base URL for the dev server proxy', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true },
      { defaultApiBaseUrl: '/api' }
    );
    expect(config.apiBaseUrl).toBe('/api');
    expect(config.environment).toBe('local');
  });

  it('strips a trailing slash from the API base URL', () => {
    // The client joins paths onto this, so a trailing slash would produce a
    // double slash on every request.
    const config = loadAppConfig({
      MODE: 'production',
      VITE_API_BASE_URL: 'https://api.webbpulse.com/api/v1/',
    });
    expect(config.apiBaseUrl).toBe('https://api.webbpulse.com/api/v1');
  });

  it('rejects a non http protocol', () => {
    expect(() =>
      loadAppConfig({
        MODE: 'production',
        VITE_API_BASE_URL: 'ftp://api.example.com',
      })
    ).toThrow(ConfigError);
  });

  describe('environment inference from the Vite mode', () => {
    const cases: [string, string][] = [
      ['development', 'local'],
      ['local', 'local'],
      ['staging', 'staging'],
      ['production', 'production'],
    ];

    for (const [mode, expected] of cases) {
      it(`maps mode ${mode} to ${expected}`, () => {
        const config = loadAppConfig(
          { MODE: mode },
          { defaultApiBaseUrl: '/api' }
        );
        expect(config.environment).toBe(expected);
      });
    }

    it('falls back to local for an unrecognised mode', () => {
      const config = loadAppConfig(
        { MODE: 'something-bespoke' },
        { defaultApiBaseUrl: '/api' }
      );
      expect(config.environment).toBe('local');
    });

    it('lets VITE_ENVIRONMENT override the inferred mode', () => {
      // A staging bundle is built with mode production but points at the
      // staging API, so the explicit variable has to win.
      const config = loadAppConfig(
        { MODE: 'production', VITE_ENVIRONMENT: 'staging' },
        { defaultApiBaseUrl: '/api' }
      );
      expect(config.environment).toBe('staging');
    });

    it('rejects an environment outside the known set', () => {
      expect(() =>
        loadAppConfig(
          { MODE: 'production', VITE_ENVIRONMENT: 'preprod' },
          { defaultApiBaseUrl: '/api' }
        )
      ).toThrow(ConfigError);
    });
  });

  it('defaults the application name and leaves the release undefined', () => {
    const config = loadAppConfig(
      { MODE: 'production' },
      {
        defaultApiBaseUrl: '/api',
      }
    );
    expect(config.appName).toBe('WebbPulse');
    expect(config.release).toBeUndefined();
  });

  it('uses the supplied default application name', () => {
    const config = loadAppConfig(
      { MODE: 'production' },
      { defaultApiBaseUrl: '/api', defaultAppName: 'Portfolio' }
    );
    expect(config.appName).toBe('Portfolio');
  });

  it('prefers an explicit API base URL over the default', () => {
    const config = loadAppConfig(
      { MODE: 'development', VITE_API_BASE_URL: 'https://api.staging.test' },
      { defaultApiBaseUrl: '/api' }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.test');
  });

  it('reports DEV and PROD from the Vite flags', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, PROD: false },
      { defaultApiBaseUrl: '/api' }
    );
    expect(config.isDev).toBe(true);
    expect(config.isProd).toBe(false);
  });
});
