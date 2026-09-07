import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigReader } from './env.js';

describe('ConfigReader.string', () => {
  it('reads a present value', () => {
    const reader = new ConfigReader({ VITE_APP_NAME: 'CarModPicker' });
    expect(reader.string('VITE_APP_NAME')).toBe('CarModPicker');
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('trims surrounding whitespace', () => {
    const reader = new ConfigReader({ VITE_APP_NAME: '  Portfolio  ' });
    expect(reader.string('VITE_APP_NAME')).toBe('Portfolio');
  });

  it('records an issue when missing', () => {
    const reader = new ConfigReader({});
    reader.string('VITE_APP_NAME');
    expect(() => {
      reader.assertValid();
    }).toThrowError(ConfigError);
  });

  it('treats an empty string as missing', () => {
    const reader = new ConfigReader({ VITE_APP_NAME: '   ' });
    reader.string('VITE_APP_NAME');
    expect(() => {
      reader.assertValid();
    }).toThrowError(ConfigError);
  });
});

describe('ConfigReader.optionalString', () => {
  it('falls back when unset', () => {
    expect(new ConfigReader({}).optionalString('VITE_X', 'fallback')).toBe(
      'fallback'
    );
  });

  it('prefers the configured value', () => {
    expect(
      new ConfigReader({ VITE_X: 'set' }).optionalString('VITE_X', 'fallback')
    ).toBe('set');
  });
});

describe('ConfigReader.url', () => {
  it('accepts an absolute https URL', () => {
    const reader = new ConfigReader({
      VITE_API_BASE_URL: 'https://api.webbpulse.com/api/v1',
    });
    expect(reader.url('VITE_API_BASE_URL')).toBe(
      'https://api.webbpulse.com/api/v1'
    );
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('strips a trailing slash', () => {
    const reader = new ConfigReader({
      VITE_API_BASE_URL: 'https://api.webbpulse.com/api/v1/',
    });
    expect(reader.url('VITE_API_BASE_URL')).toBe(
      'https://api.webbpulse.com/api/v1'
    );
  });

  it('accepts a root relative path, which both apps use for the dev proxy', () => {
    const reader = new ConfigReader({ VITE_API_BASE_URL: '/api' });
    expect(reader.url('VITE_API_BASE_URL')).toBe('/api');
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('keeps a bare root path usable', () => {
    const reader = new ConfigReader({ VITE_API_BASE_URL: '/' });
    expect(reader.url('VITE_API_BASE_URL')).toBe('/');
  });

  it('rejects a value that is neither absolute nor root relative', () => {
    const reader = new ConfigReader({ VITE_API_BASE_URL: 'api.example.com' });
    reader.url('VITE_API_BASE_URL');
    expect(() => {
      reader.assertValid();
    }).toThrowError(/must be an absolute URL or a root relative path/);
  });

  it('rejects a non http protocol', () => {
    const reader = new ConfigReader({
      VITE_API_BASE_URL: 'ftp://files.example.com',
    });
    reader.url('VITE_API_BASE_URL');
    expect(() => {
      reader.assertValid();
    }).toThrowError(/must use http or https/);
  });

  it('records an issue when required and unset', () => {
    const reader = new ConfigReader({});
    reader.url('VITE_API_BASE_URL');
    expect(() => {
      reader.assertValid();
    }).toThrowError(/is required/);
  });

  it('stays silent when not required and unset', () => {
    const reader = new ConfigReader({});
    reader.url('VITE_API_BASE_URL', { required: false });
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('uses the fallback when unset', () => {
    const reader = new ConfigReader({});
    expect(reader.url('VITE_API_BASE_URL', { fallback: '/api' })).toBe('/api');
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });
});

describe('ConfigReader.boolean', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses %s', (raw, expected) => {
    const reader = new ConfigReader({ VITE_FLAG: raw });
    expect(reader.boolean('VITE_FLAG', !expected)).toBe(expected);
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('falls back when unset', () => {
    expect(new ConfigReader({}).boolean('VITE_FLAG', true)).toBe(true);
  });

  it('records an issue for an unparseable value', () => {
    const reader = new ConfigReader({ VITE_FLAG: 'maybe' });
    reader.boolean('VITE_FLAG', false);
    expect(() => {
      reader.assertValid();
    }).toThrowError(/must be a boolean/);
  });
});

describe('ConfigReader.oneOf', () => {
  const allowed = ['local', 'staging', 'production'] as const;

  it('accepts an allowed value', () => {
    const reader = new ConfigReader({ VITE_ENVIRONMENT: 'staging' });
    expect(reader.oneOf('VITE_ENVIRONMENT', allowed)).toBe('staging');
  });

  it('uses the fallback when unset', () => {
    const reader = new ConfigReader({});
    expect(reader.oneOf('VITE_ENVIRONMENT', allowed, 'local')).toBe('local');
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });

  it('records an issue for a value outside the set', () => {
    const reader = new ConfigReader({ VITE_ENVIRONMENT: 'qa' });
    reader.oneOf('VITE_ENVIRONMENT', allowed, 'local');
    expect(() => {
      reader.assertValid();
    }).toThrowError(/must be one of local, staging, production/);
  });

  it('records an issue when required with no fallback', () => {
    const reader = new ConfigReader({});
    reader.oneOf('VITE_ENVIRONMENT', allowed);
    expect(() => {
      reader.assertValid();
    }).toThrowError(/is required/);
  });
});

describe('ConfigError aggregation', () => {
  it('reports every problem in one throw rather than only the first', () => {
    const reader = new ConfigReader({ VITE_API_BASE_URL: 'not a url' });
    reader.url('VITE_API_BASE_URL');
    reader.string('VITE_APP_NAME');
    reader.addIssue('VITE_CUSTOM failed a bespoke check');

    let caught: unknown;
    try {
      reader.assertValid();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues;
    expect(issues).toHaveLength(3);
    expect((caught as ConfigError).message).toContain('VITE_APP_NAME');
    expect((caught as ConfigError).message).toContain('VITE_CUSTOM');
  });

  it('does not throw when nothing failed', () => {
    const reader = new ConfigReader({ VITE_APP_NAME: 'x' });
    reader.string('VITE_APP_NAME');
    expect(() => {
      reader.assertValid();
    }).not.toThrow();
  });
});
