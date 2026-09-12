import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAvailabilityCache } from './availability.js';
import {
  OAUTH_PROVIDERS_PATH,
  oauthProviders,
  parseProviders,
  providerLabel,
} from './oauth.js';

const ORIGIN = 'https://api.example.test';
const PROVIDERS_URL = `${ORIGIN}${OAUTH_PROVIDERS_PATH}`;

const GOOGLE_WIRE = { id: 'google', display_name: 'Google' };
const GITHUB_WIRE = { id: 'github', display_name: 'GitHub' };
const GOOGLE = { id: 'google', displayName: 'Google' };
const GITHUB = { id: 'github', displayName: 'GitHub' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answering(body: unknown, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body, status)));
}

function notJson(): typeof fetch {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('<html>nope</html>', { status: 200 }))
  );
}

function failing(): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.reject(new TypeError('failed')));
}

function callsOf(fetchImpl: typeof fetch) {
  return vi.mocked(fetchImpl).mock.calls;
}

beforeEach(resetAvailabilityCache);
afterEach(() => {
  resetAvailabilityCache();
  vi.clearAllMocks();
});

describe('OAUTH_PROVIDERS_PATH', () => {
  it('is the route the identity package mounts', () => {
    expect(OAUTH_PROVIDERS_PATH).toBe('/api/auth/oauth/providers');
  });
});

describe('providerLabel', () => {
  it('names the two baseline providers', () => {
    expect(providerLabel('google')).toBe('Google');
    expect(providerLabel('github')).toBe('GitHub');
  });

  it('title cases a provider this build does not know', () => {
    expect(providerLabel('okta')).toBe('Okta');
    expect(providerLabel('gitlab')).toBe('Gitlab');
  });

  it('does not throw on an empty id', () => {
    expect(providerLabel('')).toBe('');
  });
});

describe('parseProviders', () => {
  it('renames the wire field to camelCase', () => {
    expect(parseProviders({ providers: [GOOGLE_WIRE] })).toEqual([GOOGLE]);
  });

  it('keeps the order the backend listed', () => {
    expect(parseProviders({ providers: [GITHUB_WIRE, GOOGLE_WIRE] })).toEqual([
      GITHUB,
      GOOGLE,
    ]);
  });

  it('names a provider the server did not', () => {
    expect(parseProviders({ providers: [{ id: 'github' }] })).toEqual([GITHUB]);
  });

  it('keeps a provider this build has never heard of', () => {
    expect(
      parseProviders({ providers: [{ id: 'okta', display_name: 'Acme SSO' }] })
    ).toEqual([{ id: 'okta', displayName: 'Acme SSO' }]);
  });

  it('drops a malformed entry rather than the whole list', () => {
    expect(
      parseProviders({
        providers: [
          GOOGLE_WIRE,
          { display_name: 'Nameless' },
          { id: '' },
          null,
          7,
        ],
      })
    ).toEqual([GOOGLE]);
  });

  it('reads a configured-nothing deployment as an empty list', () => {
    expect(parseProviders({ providers: [] })).toEqual([]);
  });

  it('reads a body that is not the envelope as nothing learned', () => {
    expect(parseProviders(null)).toBeUndefined();
    expect(parseProviders('google')).toBeUndefined();
    expect(parseProviders({})).toBeUndefined();
    expect(parseProviders({ items: [] })).toBeUndefined();
    expect(parseProviders({ providers: 'google' })).toBeUndefined();
  });
});

describe('oauthProviders', () => {
  it('returns the configured set, camelCased', async () => {
    await expect(
      oauthProviders(
        PROVIDERS_URL,
        answering({ providers: [GOOGLE_WIRE, GITHUB_WIRE] })
      )
    ).resolves.toEqual([GOOGLE, GITHUB]);
  });

  it('sends no credentials', async () => {
    const fetchImpl = answering({ providers: [] });

    await oauthProviders(PROVIDERS_URL, fetchImpl);

    expect(callsOf(fetchImpl)[0]?.[0]).toBe(PROVIDERS_URL);
    expect(callsOf(fetchImpl)[0]?.[1]).toEqual({
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  });

  it('returns nothing for a backend that predates the route', async () => {
    await expect(
      oauthProviders(PROVIDERS_URL, answering({}, 404))
    ).resolves.toEqual([]);
  });

  it('returns nothing for a 500', async () => {
    await expect(
      oauthProviders(PROVIDERS_URL, answering({}, 500))
    ).resolves.toEqual([]);
  });

  it('returns nothing when the network failed', async () => {
    await expect(oauthProviders(PROVIDERS_URL, failing())).resolves.toEqual([]);
  });

  it('returns nothing for a body that is not JSON', async () => {
    const fetchImpl = notJson();

    await expect(oauthProviders(PROVIDERS_URL, fetchImpl)).resolves.toEqual([]);
  });

  it('reads once for two callers in the same tick', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const [first, second] = await Promise.all([
      oauthProviders(PROVIDERS_URL, fetchImpl),
      oauthProviders(PROVIDERS_URL, fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual([GOOGLE]);
    expect(second).toEqual([GOOGLE]);
  });

  it('caches an empty list, because none configured is a deployment fact', async () => {
    const fetchImpl = answering({ providers: [] });

    await oauthProviders(PROVIDERS_URL, fetchImpl);
    await oauthProviders(PROVIDERS_URL, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a flaky answer is retried', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('failed'))
      .mockResolvedValueOnce(jsonResponse({ providers: [GOOGLE_WIRE] }));

    await expect(oauthProviders(PROVIDERS_URL, fetchImpl)).resolves.toEqual([]);
    await expect(oauthProviders(PROVIDERS_URL, fetchImpl)).resolves.toEqual([
      GOOGLE,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keys by URL, so two backends do not share an answer', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ providers: [GOOGLE_WIRE] }))
      .mockResolvedValueOnce(jsonResponse({ providers: [GITHUB_WIRE] }));

    await expect(oauthProviders(PROVIDERS_URL, fetchImpl)).resolves.toEqual([
      GOOGLE,
    ]);
    await expect(
      oauthProviders(`https://api.other.test${OAUTH_PROVIDERS_PATH}`, fetchImpl)
    ).resolves.toEqual([GITHUB]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
