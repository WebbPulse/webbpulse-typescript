import { createApiClient, type ApiClient } from '@webbpulse/api-client';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionState } from './session.js';

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
    retries: 0,
  });
  return { client, fetchMock };
}

describe('SessionManager construction', () => {
  it('starts in the unknown state', () => {
    const manager = new SessionManager({
      client: clientWith([]).client,
      mode: 'cookie',
    });
    expect(manager.getState()).toEqual({
      status: 'unknown',
      user: null,
      error: null,
      settled: false,
      hadUser: false,
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
      settled: true,
      hadUser: true,
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
    const { client } = clientWith([
      jsonResponse({ detail: 'Not authenticated' }, 401),
    ]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await expect(manager.refresh()).resolves.toBeNull();
    expect(manager.getState()).toEqual({
      status: 'anonymous',
      user: null,
      error: null,
      settled: true,
      hadUser: false,
    });
  });

  it('records a non 401 failure as an error', async () => {
    const { client } = clientWith([jsonResponse({ detail: 'boom' }, 500)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });

    await expect(manager.refresh()).resolves.toBeNull();
    const state = manager.getState();
    expect(state.status).toBe('anonymous');
    expect(state.error).toBeInstanceOf(Error);
  });

  it('de-duplicates concurrent refreshes into one request', async () => {
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
  it('uses a user embedded in the login response without a second call', async () => {
    const { client, fetchMock } = clientWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'cookie',
    });

    await manager.login({ username: 'alice' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('encodes credentials as form data when asked', async () => {
    const { client, fetchMock } = clientWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'cookie',
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
      mode: 'cookie',
      loginPath: '/admin/login',
    });

    await manager.login({ username: 'alice' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/admin/login'
    );
  });

  it('stays anonymous when the login is not complete', async () => {
    const { client } = clientWith([jsonResponse({ requires_2fa: true })]);
    const manager = new SessionManager<User, { username: string }>({
      client,
      mode: 'cookie',
      isLoginComplete: (response) =>
        (response as { requires_2fa?: boolean }).requires_2fa !== true,
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
      mode: 'cookie',
    });

    await expect(manager.login({ username: 'alice' })).rejects.toThrow(
      /Incorrect password/
    );
    expect(manager.getState().error).toBeInstanceOf(Error);
  });
});

describe('SessionManager.logout', () => {
  let manager: SessionManager<User, unknown>;

  it('clears the state', async () => {
    const { client } = clientWith([new Response(null, { status: 204 })]);
    manager = new SessionManager<User, unknown>({
      client,
      mode: 'cookie',
    });
    manager.setUser(ALICE);

    await manager.logout();

    expect(manager.getState()).toEqual({
      status: 'anonymous',
      user: null,
      error: null,
      settled: true,
      hadUser: false,
    });
  });

  it('ends the local session even when the server call fails', async () => {
    const { client } = clientWith([jsonResponse({ detail: 'boom' }, 500)]);
    manager = new SessionManager<User, unknown>({
      client,
      mode: 'cookie',
    });
    manager.setUser(ALICE);

    await expect(manager.logout()).resolves.toBeUndefined();
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
    const { client } = clientWith([jsonResponse(ALICE)]);
    const manager = new SessionManager<User>({ client, mode: 'cookie' });
    const before = manager.getState();

    await manager.refresh();

    expect(manager.getState()).not.toBe(before);
  });
});

describe('SessionManager setUser', () => {
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
