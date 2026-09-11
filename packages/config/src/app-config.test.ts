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

describe('loadAppConfig backendTargets', () => {
  const targets = {
    staging: 'https://api.staging.carmodpicker.com',
    production: 'https://api.carmodpicker.com',
  };

  it('selects the staging backend in dev', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'staging' },
      { defaultApiBaseUrl: '/api', backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.carmodpicker.com');
  });

  it('selects the production backend in dev', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'production' },
      { defaultApiBaseUrl: '/api', backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('https://api.carmodpicker.com');
  });

  it('falls through to the default when the switch is unset', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true },
      { defaultApiBaseUrl: '/api', backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('/api');
  });

  it('falls through when the switch names a target that is not in the map', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'local' },
      { defaultApiBaseUrl: '/api', backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('/api');
  });

  it('falls through when the mapped value is undefined', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'staging' },
      {
        defaultApiBaseUrl: '/api',
        backendTargets: { staging: undefined },
      }
    );
    expect(config.apiBaseUrl).toBe('/api');
  });

  it('matches the switch case insensitively', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'Staging' },
      { defaultApiBaseUrl: '/api', backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.carmodpicker.com');
  });

  it('ignores the switch outside dev', () => {
    const config = loadAppConfig(
      {
        MODE: 'production',
        DEV: false,
        PROD: true,
        VITE_BACKEND: 'staging',
        VITE_API_BASE_URL: 'https://api.carmodpicker.com',
      },
      { backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('https://api.carmodpicker.com');
  });

  it('wins over VITE_API_BASE_URL in dev', () => {
    const config = loadAppConfig(
      {
        MODE: 'development',
        DEV: true,
        VITE_BACKEND: 'staging',
        VITE_API_BASE_URL: '/api',
      },
      { backendTargets: targets }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.carmodpicker.com');
  });

  it('validates the selected URL and names the key that supplied it', () => {
    let caught: unknown;
    try {
      loadAppConfig(
        { MODE: 'development', DEV: true, VITE_BACKEND: 'staging' },
        { backendTargets: { staging: 'not a url' } }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues[0]).toContain('VITE_BACKEND=staging');
  });

  it('reads the switch from a custom key', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_TARGET: 'staging' },
      {
        defaultApiBaseUrl: '/api',
        backendTargets: targets,
        backendTargetKey: 'VITE_TARGET',
      }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.carmodpicker.com');
  });

  it('strips a trailing slash from a selected target', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'staging' },
      { backendTargets: { staging: 'https://api.staging.test/' } }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.test');
  });
});

describe('loadAppConfig apiPathPrefix', () => {
  it('appends the prefix to an absolute base URL', () => {
    const config = loadAppConfig(
      { MODE: 'production', VITE_API_BASE_URL: 'https://api.carmodpicker.com' },
      { apiPathPrefix: '/api' }
    );
    expect(config.apiBaseUrl).toBe('https://api.carmodpicker.com/api');
  });

  it('appends the prefix to a root relative base URL', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true },
      { defaultApiBaseUrl: '/', apiPathPrefix: '/api' }
    );
    expect(config.apiBaseUrl).toBe('/api');
  });

  it('does not double the prefix when the URL already carries it', () => {
    const config = loadAppConfig(
      {
        MODE: 'production',
        VITE_API_BASE_URL: 'https://api.carmodpicker.com/api',
      },
      { apiPathPrefix: '/api' }
    );
    expect(config.apiBaseUrl).toBe('https://api.carmodpicker.com/api');
  });

  it('does not double the prefix on a root relative URL', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true },
      { defaultApiBaseUrl: '/api', apiPathPrefix: '/api' }
    );
    expect(config.apiBaseUrl).toBe('/api');
  });

  it('accepts a prefix written without a leading slash', () => {
    const config = loadAppConfig(
      { MODE: 'production', VITE_API_BASE_URL: 'https://api.test' },
      { apiPathPrefix: 'api' }
    );
    expect(config.apiBaseUrl).toBe('https://api.test/api');
  });

  it('applies to a backend target too', () => {
    const config = loadAppConfig(
      { MODE: 'development', DEV: true, VITE_BACKEND: 'staging' },
      {
        defaultApiBaseUrl: '/api',
        backendTargets: { staging: 'https://api.staging.test' },
        apiPathPrefix: '/api',
      }
    );
    expect(config.apiBaseUrl).toBe('https://api.staging.test/api');
  });

  it('is a no-op for a bare slash prefix', () => {
    const config = loadAppConfig(
      { MODE: 'production', VITE_API_BASE_URL: 'https://api.test' },
      { apiPathPrefix: '/' }
    );
    expect(config.apiBaseUrl).toBe('https://api.test');
  });

  it('appends a multi segment prefix', () => {
    const config = loadAppConfig(
      { MODE: 'production', VITE_API_BASE_URL: 'https://api.test' },
      { apiPathPrefix: '/api/v1' }
    );
    expect(config.apiBaseUrl).toBe('https://api.test/api/v1');
  });

  it('leaves the defaults untouched when neither option is given', () => {
    const config = loadAppConfig(
      { MODE: 'production', VITE_API_BASE_URL: 'https://api.test/' },
      { defaultAppName: 'Portfolio' }
    );
    expect(config.apiBaseUrl).toBe('https://api.test');
    expect(config.appName).toBe('Portfolio');
  });
});
