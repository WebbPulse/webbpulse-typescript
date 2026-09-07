import { createApiClient, type ApiClient } from '@webbpulse/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionState } from './session.js';
import { MemoryTokenStorage } from './storage.js';

interface User {
  id: number;
  username: string;
}

const ALICE: User = { id: 1, username: 'alice' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Builds a client over a queued fetch stub, plus the stub for assertions. */
function clientWith(results: (Response | Error)[]): {
  client: ApiClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const fetchMock = vi.fn(() => {
    const result = results.at(Math.min(index, results.length - 1));
    index += 1;
    if (result === undefined) {
      throw new Error('The fetch stub was called with no queued result.');
    }
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result.clone());
  });
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: fetchMock,
    // Retries off so a queued 500 is observed once, not swallowed by a retry.
    retries: 0,
  });
  return { client, fetchMock };
}

describe('SessionManager construction', () => {
  it('requires a token key in token mode', () => {
    // The two applications use different keys, so a default would silently
    // sign one of them out on the deploy that adopts this package.
    expect(
      () =>
        new SessionManager({
          client: clientWith([]).client,
          mode: 'token',
        })
    ).toThrow(/tokenStorageKey is required/);
  });

  it('does not require a token key in cookie mode', () => {
    expect(
      () =>
        new SessionManager({
          client: clientWith([]).client,
          mode: 'cookie',
        })
    ).not.toThrow();
  });

  it('starts in the unknown state', () => {
    const manager = new SessionManager({
      client: clientWith([]).client,
      mode: 'cookie',
    });
    expect(manager.getState()).toEqual({
      status: 'unknown',
      user: null,
      error: null,
    });
  });
});

describe('SessionManager.refresh', () => {
  it('authenticates from the current user endpoint', async () => {
    const { client, fetchMock } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await expect(manager.refresh()).resolves.toEqual(ALICE);
    expect(manager.getState()).toEqual({
      status: 'authenticated',
      user: ALICE,
      error: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/users/me'
    );
  });

  it('honours a custom current user path', async () => {
    const { client, fetchMock } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({
      client,
      mode: 'cookie',
      currentUserPath: '/api/v1/admin/me',
    });

    await manager.refresh();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/api/v1/admin/me'
    );
  });

  it('treats a 401 as anonymous rather than an error', async () => {
    // Nobody being signed in is an expected answer, not a failure, so it must
    // not surface as an error the UI would render.
    const { client } = clientWith([
      jsonResponse({ detail: 'Not authenticated' }, 401),
    ]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await expect(manager.refresh()).resolves.toBeNull();
    expect(manager.getState()).toEqual({
      status: 'anonymous',
      user: null,
      error: null,
    });
  });

  it('clears a stale token on a 401', async () => {
    const storage = new MemoryTokenStorage();
    storage.setItem('access_token', 'expired');
    const { client } = clientWith([jsonResponse({ detail: 'nope' }, 401)]);
    const manager = new SessionManager<User>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });

    await manager.refresh();
    expect(manager.getToken()).toBeNull();
  });

  it('records a non 401 failure as an error', async () => {
    const { client } = clientWith([jsonResponse({ detail: 'boom' }, 500)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await expect(manager.refresh()).resolves.toBeNull();
    const state = manager.getState();
    expect(state.status).toBe('anonymous');
    expect(state.error).toBeInstanceOf(Error);
  });

  it('keeps a token that a server error did not invalidate', async () => {
    // A 500 says nothing about the session, so discarding the token would sign
    // the user out over an unrelated backend fault.
    const storage = new MemoryTokenStorage();
    storage.setItem('access_token', 'still-good');
    const { client } = clientWith([jsonResponse({ detail: 'boom' }, 500)]);
    const manager = new SessionManager<User>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });

    await manager.refresh();
    expect(manager.getToken()).toBe('still-good');
  });

  it('de-duplicates concurrent refreshes into one request', async () => {
    // A burst of mounting components must not stampede the current user
    // endpoint.
    const { client, fetchMock } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    const [a, b, c] = await Promise.all([
      manager.refresh(),
      manager.refresh(),
      manager.refresh(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([ALICE, ALICE, ALICE]);
  });

  it('allows a later refresh after the first settles', async () => {
    const { client, fetchMock } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await manager.refresh();
    await manager.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SessionManager.login', () => {
  it('stores the token and resolves the user in token mode', async () => {
    const storage = new MemoryTokenStorage();
    const { client } = clientWith([
      jsonResponse({ access_token: 'tok', token_type: 'bearer' }),
      jsonResponse(ALICE),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });

    const result = await manager.login({ username: 'alice' });

    expect(manager.getToken()).toBe('tok');
    expect(result.user).toEqual(ALICE);
    expect(manager.getState().status).toBe('authenticated');
  });

  it('uses a user embedded in the login response without a second call', async () => {
    const { client, fetchMock } = clientWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: new MemoryTokenStorage(),
    });

    await manager.login({ username: 'alice' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('encodes credentials as form data when asked', async () => {
    // CarModPicker posts application/x-www-form-urlencoded to an OAuth2
    // password flow endpoint, so the encoder has to be overridable.
    const { client, fetchMock } = clientWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: new MemoryTokenStorage(),
      encodeCredentials: (credentials) =>
        new URLSearchParams({ username: credentials.username }),
    });

    await manager.login({ username: 'alice' });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(URLSearchParams);
  });

  it('honours a custom login path', async () => {
    const { client, fetchMock } = clientWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'authToken',
      tokenStorage: new MemoryTokenStorage(),
      loginPath: '/admin/login',
    });

    await manager.login({ username: 'alice' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/admin/login'
    );
  });

  it('stays anonymous when the response carries neither token nor user', async () => {
    // A pending second factor is the usual reason. Claiming a session here
    // would let the UI past a gate the API has not opened.
    const { client } = clientWith([jsonResponse({ requires_2fa: true })]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: new MemoryTokenStorage(),
    });

    const result = await manager.login({ username: 'alice' });
    expect(result.user).toBeNull();
    expect(result.raw).toEqual({ requires_2fa: true });
    expect(manager.getState().status).toBe('anonymous');
  });

  it('rethrows a failed login and records the error', async () => {
    const { client } = clientWith([
      jsonResponse({ detail: 'Incorrect password' }, 401),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: new MemoryTokenStorage(),
    });

    await expect(manager.login({ username: 'alice' })).rejects.toThrow(
      /Incorrect password/
    );
    expect(manager.getState().error).toBeInstanceOf(Error);
  });
});

describe('SessionManager.logout', () => {
  let manager: SessionManager<User, unknown>;
  let storage: MemoryTokenStorage;

  beforeEach(() => {
    storage = new MemoryTokenStorage();
    storage.setItem('access_token', 'tok');
  });

  it('clears the token and the state', async () => {
    const { client } = clientWith([new Response(null, { status: 204 })]);
    manager = new SessionManager<User, unknown>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });
    manager.setUser(ALICE);

    await manager.logout();

    expect(manager.getToken()).toBeNull();
    expect(manager.getState()).toEqual({
      status: 'anonymous',
      user: null,
      error: null,
    });
  });

  it('ends the local session even when the server call fails', async () => {
    // Otherwise a network failure strands the user in a session the UI still
    // believes in, with no way to sign out.
    const { client } = clientWith([jsonResponse({ detail: 'boom' }, 500)]);
    manager = new SessionManager<User, unknown>({
      client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });
    manager.setUser(ALICE);

    await expect(manager.logout()).resolves.toBeUndefined();
    expect(manager.getToken()).toBeNull();
    expect(manager.getState().status).toBe('anonymous');
  });
});

describe('SessionManager subscriptions', () => {
  it('notifies subscribers on every transition', async () => {
    const { client } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });
    const seen: SessionState<User>[] = [];
    manager.subscribe((state) => seen.push(state));

    await manager.refresh();

    expect(seen.map((state) => state.status)).toEqual([
      'loading',
      'authenticated',
    ]);
  });

  it('stops notifying after unsubscribe', async () => {
    const { client } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);

    unsubscribe();
    await manager.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  it('hands out a new state object per transition', async () => {
    // useSyncExternalStore compares snapshots by reference, so a mutated
    // object in place would leave React on a stale render.
    const { client } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });
    const before = manager.getState();

    await manager.refresh();

    expect(manager.getState()).not.toBe(before);
  });
});

describe('SessionManager token rotation', () => {
  it('stores a token the API rotated in mid session', () => {
    const storage = new MemoryTokenStorage();
    const manager = new SessionManager<User>({
      client: clientWith([]).client,
      mode: 'token',
      tokenStorageKey: 'access_token',
      tokenStorage: storage,
    });

    manager.setToken('rotated');
    expect(manager.getToken()).toBe('rotated');
  });

  it('is a no-op in cookie mode', () => {
    const manager = new SessionManager<User>({
      client: clientWith([]).client,
      mode: 'cookie',
    });

    expect(() => {
      manager.setToken('ignored');
    }).not.toThrow();
    expect(manager.getToken()).toBeNull();
  });

  it('setUser(null) returns the session to anonymous', () => {
    const manager = new SessionManager<User>({
      client: clientWith([]).client,
      mode: 'cookie',
    });
    manager.setUser(ALICE);
    expect(manager.getState().status).toBe('authenticated');

    manager.setUser(null);
    expect(manager.getState().status).toBe('anonymous');
  });
});
