import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIdentityClientSingleton,
  identityOriginFrom,
  identityUrl,
  DEFAULT_CURRENT_USER_PATH,
} from './browser.js';
import type { AuthClient, AuthClientOptions } from './auth-client.js';
import type { WebAuthnAdapter } from './passkeys.js';
import type { ApiClient } from '@webbpulse/api-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identityOriginFrom', () => {
  it('strips a deployed API base back to its origin', () => {
    expect(identityOriginFrom('https://api.carmodpicker.com/api')).toBe(
      'https://api.carmodpicker.com'
    );
  });

  it('keeps a non default port', () => {
    expect(identityOriginFrom('http://localhost:8000/api')).toBe(
      'http://localhost:8000'
    );
  });

  it('returns an empty base for a root relative API base', () => {
    expect(identityOriginFrom('/api')).toBe('');
  });

  it('passes a root relative base through when asked', () => {
    expect(identityOriginFrom('/api/v1', { relativeAs: 'passthrough' })).toBe(
      '/api/v1'
    );
  });

  it('returns a malformed value unchanged', () => {
    expect(identityOriginFrom('not a url')).toBe('not a url');
  });

  it('never produces a base that would double the api prefix', () => {
    for (const base of [
      'https://api.carmodpicker.com/api',
      'http://localhost:8000/api',
      '/api',
    ]) {
      expect(identityOriginFrom(base) + '/api/auth/login').not.toContain(
        '/api/api/auth'
      );
    }
  });
});

describe('identityUrl', () => {
  it('joins an origin onto an absolute path', () => {
    expect(identityUrl('https://api.example.com', '/api/auth/passkeys')).toBe(
      'https://api.example.com/api/auth/passkeys'
    );
  });

  it('yields the path alone for an empty origin', () => {
    expect(identityUrl('', '/api/auth/passkeys')).toBe('/api/auth/passkeys');
  });
});

describe('createIdentityClientSingleton', () => {
  it('builds a client once and caches it', () => {
    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
    });

    const first = identity.getClient();
    expect(first).not.toBeNull();
    expect(identity.getClient()).toBe(first);
  });

  it('defaults the current user path to the gateway route', () => {
    const identity = createIdentityClientSingleton({
      apiBaseUrl: '/api',
    });
    expect(identity.currentUserPath).toBe(DEFAULT_CURRENT_USER_PATH);
    expect(DEFAULT_CURRENT_USER_PATH).toBe('/api/users/me');
  });

  it('resolves identityUrl against the configured base', () => {
    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
    });
    expect(identity.identityOrigin()).toBe('https://api.example.com');
    expect(identity.identityUrl('/api/auth/passkeys/available')).toBe(
      'https://api.example.com/api/auth/passkeys/available'
    );
  });

  it('never doubles the api prefix on the current user path', () => {
    for (const base of [
      'https://api.carmodpicker.com/api',
      'http://localhost:8000/api',
      '/api',
    ]) {
      const identity = createIdentityClientSingleton({ apiBaseUrl: base });
      expect(
        identity.identityOrigin() + identity.currentUserPath
      ).not.toContain('/api/api/');
    }
  });

  it('reads a base URL thunk on every build, not once at construction', () => {
    let base = 'https://first.example.com/api';
    const identity = createIdentityClientSingleton({
      apiBaseUrl: () => base,
    });

    expect(identity.identityOrigin()).toBe('https://first.example.com');
    base = 'https://second.example.com/api';
    expect(identity.identityOrigin()).toBe('https://second.example.com');
  });

  it('falls back to the page origin when the base reduces to empty', () => {
    vi.stubGlobal('location', { origin: 'https://app.example.com' });
    const identity = createIdentityClientSingleton({ apiBaseUrl: '/api' });

    const client = identity.getClient() as unknown as { baseUrl?: string };
    expect(identity.identityOrigin()).toBe('');
    expect(client).not.toBeNull();
  });

  it('honours a passthrough relative origin', () => {
    const identity = createIdentityClientSingleton({
      apiBaseUrl: '/api/v1',
      relativeAs: 'passthrough',
    });
    expect(identity.identityOrigin()).toBe('/api/v1');
  });

  it('reads the signed in user through the default loadUser', async () => {
    let captured: AuthClientOptions<{ id: number }>['loadUser'];
    const identity = createIdentityClientSingleton<{ id: number }>({
      apiBaseUrl: 'https://api.example.com/api',
      createClient: (options) => {
        captured = options.loadUser;
        return { dispose: () => undefined } as unknown as AuthClient<{
          id: number;
        }>;
      },
    });
    identity.getClient();

    const get = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const user = await captured?.({ get } as unknown as ApiClient);

    expect(get).toHaveBeenCalledWith('/api/users/me');
    expect(user).toEqual({ id: 1 });
  });

  it('resolves a missing user record to null rather than undefined', async () => {
    let captured: AuthClientOptions<{ id: number }>['loadUser'];
    const identity = createIdentityClientSingleton<{ id: number }>({
      apiBaseUrl: 'https://api.example.com/api',
      createClient: (options) => {
        captured = options.loadUser;
        return { dispose: () => undefined } as unknown as AuthClient<{
          id: number;
        }>;
      },
    });
    identity.getClient();

    const get = vi.fn().mockResolvedValue({ data: undefined });
    await expect(
      captured?.({ get } as unknown as ApiClient)
    ).resolves.toBeNull();
  });

  it('builds with credentials include and a thirty second timeout', () => {
    let captured: AuthClientOptions<unknown> | undefined;
    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
      createClient: (options) => {
        captured = options;
        return { dispose: () => undefined } as unknown as AuthClient<unknown>;
      },
    });
    identity.getClient();

    expect(captured?.baseUrl).toBe('https://api.example.com');
    expect(captured?.clientOptions).toMatchObject({
      credentials: 'include',
      timeoutMs: 30000,
    });
  });

  it('rebuilds after resetForTests, picking up a new base URL', () => {
    let base = 'https://first.example.com/api';
    const identity = createIdentityClientSingleton({
      apiBaseUrl: () => base,
    });

    const first = identity.getClient();
    base = 'https://second.example.com/api';
    expect(identity.getClient()).toBe(first);

    identity.resetForTests();
    const second = identity.getClient();
    expect(second).not.toBe(first);
    expect(identity.identityOrigin()).toBe('https://second.example.com');
  });

  it('disposes the cached client on reset', () => {
    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
    });
    const client = identity.getClient();
    expect(client).not.toBeNull();
    const dispose = vi.spyOn(
      client as unknown as { dispose: () => void },
      'dispose'
    );

    identity.resetForTests();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('installs a WebAuthn adapter for the tests that need one', () => {
    const adapter = {
      create: vi.fn(),
      get: vi.fn(),
    } as unknown as WebAuthnAdapter;

    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
    });
    identity.setWebAuthnAdapterForTests(adapter);

    expect(identity.getClient()).not.toBeNull();
  });

  it('clears the adapter seam on reset', () => {
    const adapter = {
      create: vi.fn(),
      get: vi.fn(),
    } as unknown as WebAuthnAdapter;

    const identity = createIdentityClientSingleton({
      apiBaseUrl: 'https://api.example.com/api',
    });
    identity.setWebAuthnAdapterForTests(adapter);
    identity.getClient();
    identity.resetForTests();

    expect(identity.getClient()).not.toBeNull();
  });

  it('keeps two singletons independent', () => {
    const one = createIdentityClientSingleton({
      apiBaseUrl: 'https://one.example.com/api',
    });
    const two = createIdentityClientSingleton({
      apiBaseUrl: 'https://two.example.com/api',
    });

    expect(one.getClient()).not.toBe(two.getClient());
    expect(one.identityOrigin()).toBe('https://one.example.com');
    expect(two.identityOrigin()).toBe('https://two.example.com');
  });
});
