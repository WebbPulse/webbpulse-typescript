import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachedAvailability,
  identityOriginFrom,
  identityUrl,
  resetAvailabilityCache,
  type Availability,
} from './availability.js';

beforeEach(resetAvailabilityCache);

describe('cachedAvailability', () => {
  it('runs the probe once per key per page load', async () => {
    const probe = vi
      .fn<() => Promise<Availability>>()
      .mockResolvedValue('available');

    await expect(cachedAvailability('a', probe)).resolves.toBe('available');
    await expect(cachedAvailability('a', probe)).resolves.toBe('available');

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('coalesces two callers asking on the same paint', async () => {
    let settle: (value: Availability) => void = () => undefined;
    const probe = vi.fn(
      () =>
        new Promise<Availability>((resolve) => {
          settle = resolve;
        })
    );

    const both = Promise.all([
      cachedAvailability('a', probe),
      cachedAvailability('a', probe),
    ]);
    settle('available');

    await expect(both).resolves.toEqual(['available', 'available']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps an unavailable answer, which is a deployment fact', async () => {
    const probe = vi
      .fn<() => Promise<Availability>>()
      .mockResolvedValue('unavailable');

    await cachedAvailability('a', probe);
    await cachedAvailability('a', probe);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('evicts an unknown answer so the next ask retries', async () => {
    const probe = vi
      .fn<() => Promise<Availability>>()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValue('available');

    await expect(cachedAvailability('a', probe)).resolves.toBe('unknown');
    await expect(cachedAvailability('a', probe)).resolves.toBe('available');

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keys by URL, so two backends do not share an answer', async () => {
    const probe = vi
      .fn<() => Promise<Availability>>()
      .mockResolvedValue('available');

    await cachedAvailability('https://a.test/x', probe);
    await cachedAvailability('https://b.test/x', probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('resetAvailabilityCache', () => {
  it('makes the next ask read again', async () => {
    const probe = vi
      .fn<() => Promise<Availability>>()
      .mockResolvedValue('available');

    await cachedAvailability('a', probe);
    resetAvailabilityCache();
    await cachedAvailability('a', probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('identityOriginFrom', () => {
  it('strips an absolute base URL back to its origin', () => {
    expect(identityOriginFrom('https://api.example.test/api')).toBe(
      'https://api.example.test'
    );
  });

  it('drops a port only when the scheme implies it', () => {
    expect(identityOriginFrom('https://api.example.test:8443/api')).toBe(
      'https://api.example.test:8443'
    );
    expect(identityOriginFrom('https://api.example.test:443/api')).toBe(
      'https://api.example.test'
    );
  });

  it('reads a root relative base as the empty origin by default', () => {
    expect(identityOriginFrom('/api')).toBe('');
  });

  it('keeps a root relative base when asked to pass it through', () => {
    expect(identityOriginFrom('/api', { relativeAs: 'passthrough' })).toBe(
      '/api'
    );
  });

  it('passes through explicitly asking for the empty form', () => {
    expect(identityOriginFrom('/api', { relativeAs: 'empty' })).toBe('');
  });

  it('returns a value that is neither, unchanged rather than guessed at', () => {
    expect(identityOriginFrom('api.example.test')).toBe('api.example.test');
    expect(identityOriginFrom('')).toBe('');
  });
});

describe('identityUrl', () => {
  it('prefixes an origin onto an absolute path', () => {
    expect(identityUrl('https://api.example.test', '/api/auth/x')).toBe(
      'https://api.example.test/api/auth/x'
    );
  });

  it('leaves the path alone for an empty origin', () => {
    expect(identityUrl('', '/api/auth/x')).toBe('/api/auth/x');
  });

  it('joins a passthrough relative origin onto the path', () => {
    expect(identityUrl('/api', '/api/auth/x')).toBe('/api/api/auth/x');
  });
});
