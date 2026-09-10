import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it, vi } from 'vitest';

import { AuthClient, createAuthClient, type AuthState } from './auth-client.js';
import { AuthSessionEndedError } from './errors.js';

interface User {
  id: string;
  email: string;
}

const ALICE: User = { id: 'u_1', email: 'alice@example.test' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The envelope every WebbPulse backend renders on a non 2xx. */
function envelope(status: number, code: string, message = 'Denied.'): Response {
  return jsonResponse(
    {
      success: false,
      status,
      message,
      request_id: 'req_test',
      error_code: code,
    },
    status
  );
}

/**
 * A fetch stub routed by URL rather than by call order.
 *
 * Order-queued stubs are unusable for the concurrency tests here: the whole
 * point of those is that several requests are in flight at once, so which of
 * them reaches the stub first is exactly the thing under test and must not also
 * decide what it gets back.
 */
function routedFetch(routes: {
  [pathSuffix: string]: (call: number, init: RequestInit) => Response | Error;
}): ReturnType<typeof vi.fn> {
  const counts = new Map<string, number>();
  return vi.fn((url: string | URL, init: RequestInit = {}) => {
    const href = typeof url === 'string' ? url : url.href;
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((suffix) => href.includes(suffix));
    if (key === undefined) {
      return Promise.reject(new Error(`No route stubbed for ${href}`));
    }
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    const handler = routes[key];
    if (handler === undefined) {
      return Promise.reject(new Error(`No route stubbed for ${href}`));
    }
    const result = handler(seen, init);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
}

/** An auth client over a stubbed fetch, with timers off unless asked for. */
function authWith(
  fetchMock: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof createAuthClient<User>>[0]> = {}
): AuthClient<User> {
  return createAuthClient<User>({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    clientOptions: { fetch: fetchMock, retries: 0 },
    ...options,
  });
}

/** A deferred, for holding a stubbed response open across assertions. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AuthClient construction', () => {
  it('requires a base URL or a client', () => {
    expect(() => new AuthClient({})).toThrow(/baseUrl or an existing client/);
  });

  it('starts unknown with no token', () => {
    const auth = authWith(routedFetch({}));
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState()).toEqual({
      status: 'unknown',
      user: null,
      hasAccessToken: false,
      error: null,
      pendingMfa: null,
    });
  });

  it('sends credentials on every request, so the cookie is attached', async () => {
    // Without this the refresh cookie is never sent cross origin, and silent
    // refresh cannot work at all. Section 7.1 and 5.5.
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock);

    await auth.initialize();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('include');
  });
});

describe('AuthClient storage', () => {
  /**
   * The rule the whole design rests on: the access token is in memory and
   * nowhere a script can read it back after a reload.
   *
   * The assertion is on the storage APIs rather than on the absence of a
   * particular key, because a future implementation writing under a different
   * name would pass a key-specific check and still be wrong.
   */
  it('never touches localStorage, sessionStorage, or document.cookie', async () => {
    const localSet = vi.fn();
    const localGet = vi.fn(() => null);
    const sessionSet = vi.fn();
    const sessionGet = vi.fn(() => null);
    const cookieSet = vi.fn();

    vi.stubGlobal('localStorage', {
      getItem: localGet,
      setItem: localSet,
      removeItem: vi.fn(),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: sessionGet,
      setItem: sessionSet,
      removeItem: vi.fn(),
    });
    const documentStub = {} as { cookie: string };
    Object.defineProperty(documentStub, 'cookie', {
      get: () => '',
      set: cookieSet,
      configurable: true,
    });
    vi.stubGlobal('document', documentStub);

    try {
      const fetchMock = routedFetch({
        '/api/auth/login': () =>
          jsonResponse({ access_token: 'a1', expires_in: 600 }),
        '/api/auth/refresh': () =>
          jsonResponse({ access_token: 'a2', expires_in: 600 }),
        '/api/auth/logout': () => new Response(null, { status: 204 }),
      });
      const auth = authWith(fetchMock);

      await auth.login({ email: 'a@b.test', password: 'pw' });
      expect(auth.getAccessToken()).toBe('a1');
      await auth.refresh();
      expect(auth.getAccessToken()).toBe('a2');
      await auth.logout();

      expect(localSet).not.toHaveBeenCalled();
      expect(localGet).not.toHaveBeenCalled();
      expect(sessionSet).not.toHaveBeenCalled();
      expect(sessionGet).not.toHaveBeenCalled();
      expect(cookieSet).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loses the token on a new instance, which a reload simulates', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock);
    await auth.login({ email: 'a@b.test', password: 'pw' });
    expect(auth.getAccessToken()).toBe('a1');

    // A reload constructs a fresh client. Nothing carries over, which is the
    // property that makes the token unreachable to a later script.
    const reloaded = authWith(fetchMock);
    expect(reloaded.getAccessToken()).toBeNull();
  });
});

describe('AuthClient.initialize', () => {
  it('signs the user in from a valid cookie with no login screen', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, {
      loadUser: () => Promise.resolve(ALICE),
    });

    await expect(auth.initialize()).resolves.toEqual(ALICE);
    expect(auth.getState().status).toBe('authenticated');
    expect(auth.getState().hasAccessToken).toBe(true);
    expect(auth.getAccessToken()).toBe('a1');
  });

  it('renders anonymous when there is no cookie', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => envelope(401, 'INVALID_TOKEN'),
    });
    const auth = authWith(fetchMock);

    await expect(auth.initialize()).resolves.toBeNull();
    expect(auth.getState().status).toBe('anonymous');
    // Not an error the page should render. Nobody was signed in.
    expect(auth.getState().error).toBeNull();
  });

  it('does not fire onSessionEnded for a first time visitor', async () => {
    // A visitor who never had a session must not be bounced to a login screen
    // they did not ask for.
    const onSessionEnded = vi.fn();
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => envelope(401, 'INVALID_TOKEN'),
    });
    const auth = authWith(fetchMock, { onSessionEnded });

    await auth.initialize();
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent calls', async () => {
    // React StrictMode double mounts every provider in development, so this is
    // the normal case and not an edge one.
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    const auth = authWith(fetchMock);

    const all = Promise.all([
      auth.initialize(),
      auth.initialize(),
      auth.initialize(),
    ]);
    gate.resolve(jsonResponse({ access_token: 'a1', expires_in: 600 }));
    await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry the refresh call', async () => {
    // The server rotates on the first attempt, so a retry presents a consumed
    // token and reads as reuse, which revokes the family.
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => envelope(500, 'INTERNAL_ERROR'),
    });
    const auth = authWith(fetchMock, {
      clientOptions: { fetch: fetchMock, retries: 5 },
    });

    await auth.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AuthClient.refresh single flight', () => {
  it('makes one request for many concurrent callers', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    const auth = authWith(fetchMock);

    const calls = Array.from({ length: 10 }, () => auth.refresh());
    gate.resolve(jsonResponse({ access_token: 'a1', expires_in: 600 }));
    const tokens = await Promise.all(calls);

    // Ten rotations would look like refresh token reuse to the server, which
    // revokes the whole family and signs the user out of a correct session.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(Array.from({ length: 10 }, () => 'a1'));
  });

  it('starts a fresh request once the first has settled', async () => {
    let n = 0;
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => {
        n += 1;
        return jsonResponse({ access_token: `a${String(n)}`, expires_in: 600 });
      },
    });
    const auth = authWith(fetchMock);

    await expect(auth.refresh()).resolves.toBe('a1');
    await expect(auth.refresh()).resolves.toBe('a2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares the failure too, rather than each caller retrying', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    const auth = authWith(fetchMock);

    const calls = Array.from({ length: 5 }, () => auth.refresh());
    gate.resolve(envelope(401, 'SESSION_REVOKED'));
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([null, null, null, null, null]);
  });
});

describe('AuthClient refresh failure', () => {
  it('clears the token and the state, and emits logged out', async () => {
    const onSessionEnded = vi.fn();
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/refresh': () => envelope(401, 'SESSION_REVOKED'),
    });
    const auth = authWith(fetchMock, {
      onSessionEnded,
      loadUser: () => Promise.resolve(ALICE),
    });
    const seen: AuthState<User>[] = [];
    auth.subscribe((state) => seen.push(state));

    await auth.login({ email: 'a@b.test', password: 'pw' });
    expect(auth.getState().status).toBe('authenticated');

    await expect(auth.refresh()).resolves.toBeNull();

    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState()).toEqual({
      status: 'anonymous',
      user: null,
      hasAccessToken: false,
      error: null,
      pendingMfa: null,
    });
    expect(seen.at(-1)?.status).toBe('anonymous');

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    const ended = onSessionEnded.mock.calls[0]?.[0] as AuthSessionEndedError;
    expect(ended).toBeInstanceOf(AuthSessionEndedError);
    expect(ended.reason).toBe('refresh-failed');
    expect(ended.code).toBe('SESSION_REVOKED');
  });

  it('emits logged out once for a burst of concurrent refreshes', async () => {
    const onSessionEnded = vi.fn();
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    const auth = authWith(fetchMock, {
      onSessionEnded,
    });

    const calls = Array.from({ length: 6 }, () => auth.refresh());
    gate.resolve(envelope(401, 'SESSION_REVOKED'));
    await Promise.all(calls);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('records a server error, which says nothing about the session', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => envelope(500, 'INTERNAL_ERROR', 'Boom.'),
    });
    const auth = authWith(fetchMock);

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.getState().error).toBeInstanceOf(AuthSessionEndedError);
  });

  it('treats a refresh response with no token as a failure', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () => jsonResponse({ expires_in: 600 }),
    });
    const auth = authWith(fetchMock);

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().status).toBe('anonymous');
  });
});

describe('AuthClient.login', () => {
  it('holds the token in memory and reports the lifetime', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, {
      loadUser: () => Promise.resolve(ALICE),
    });

    const outcome = await auth.login({ email: 'a@b.test', password: 'pw' });

    expect(outcome).toEqual({
      mfaRequired: false,
      user: ALICE,
      expiresIn: 600,
    });
    expect(auth.getAccessToken()).toBe('a1');
  });

  it('uses a user embedded in the response without a second call', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    });
    const loadUser = vi.fn(() => Promise.resolve(ALICE));
    const auth = authWith(fetchMock, { loadUser });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    expect(loadUser).not.toHaveBeenCalled();
  });

  it('returns the MFA challenge rather than a token on the first leg', async () => {
    // The first leg returns no access token by design (2.6). This is a
    // successful outcome, not an error.
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({
          mfa_required: true,
          mfa_ticket: 'tkt',
          factors: ['totp', 'webauthn'],
        }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.login({ email: 'a@b.test', password: 'pw' });

    expect(outcome).toEqual({
      mfaRequired: true,
      ticket: 'tkt',
      factors: ['totp', 'webauthn'],
    });
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().status).toBe('anonymous');
    expect(auth.getState().pendingMfa).toEqual({
      ticket: 'tkt',
      factors: ['totp', 'webauthn'],
    });
  });

  it('completes the second leg with a TOTP code', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login/totp': () =>
        jsonResponse({ access_token: 'a2', expires_in: 600, user: ALICE }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.completeTotp({ ticket: 'tkt', code: '123456' });

    expect(outcome).toEqual({
      mfaRequired: false,
      user: ALICE,
      expiresIn: 600,
    });
    expect(auth.getAccessToken()).toBe('a2');
    expect(auth.getState().pendingMfa).toBeNull();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      mfa_ticket: 'tkt',
      code: '123456',
    });
  });

  it('rejects a failed login and records the error', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        envelope(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'),
    });
    const auth = authWith(fetchMock);

    await expect(
      auth.login({ email: 'a@b.test', password: 'wrong' })
    ).rejects.toBeInstanceOf(ApiError);
    expect(auth.getState().status).toBe('anonymous');
    expect(auth.getState().error).toBeInstanceOf(Error);
  });

  it('does not retry a failed login', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () => envelope(429, 'RATE_LIMITED'),
    });
    const auth = authWith(fetchMock, {
      clientOptions: { fetch: fetchMock, retries: 3 },
    });

    await expect(
      auth.login({ email: 'a@b.test', password: 'pw' })
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when loadUser fails', async () => {
    // The token is valid; the profile endpoint is a separate concern. Signing
    // someone out over it would be a worse outcome than a null user.
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, {
      loadUser: () => Promise.reject(new Error('profile down')),
    });

    const outcome = await auth.login({ email: 'a@b.test', password: 'pw' });

    expect(outcome.mfaRequired).toBe(false);
    expect(auth.getAccessToken()).toBe('a1');
    expect(auth.getState().status).toBe('authenticated');
    expect(auth.getState().user).toBeNull();
    expect(auth.getState().error?.message).toBe('profile down');
  });
});

describe('AuthClient.logout', () => {
  it('calls the backend, clears memory, and emits logged out', async () => {
    const onSessionEnded = vi.fn();
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const auth = authWith(fetchMock, {
      onSessionEnded,
      loadUser: () => Promise.resolve(ALICE),
    });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    await auth.logout();

    const logoutCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/auth/logout')
    );
    expect(logoutCall).toBeDefined();
    // The bearer token goes out so the server can revoke the right family.
    const headers = new Headers((logoutCall?.[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer a1');

    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().status).toBe('anonymous');
    expect(auth.getState().user).toBeNull();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(
      (onSessionEnded.mock.calls[0]?.[0] as AuthSessionEndedError).reason
    ).toBe('logged-out');
  });

  it('ends the local session even when the server call fails', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/logout': () => new Error('network down'),
    });
    const auth = authWith(fetchMock);

    await auth.login({ email: 'a@b.test', password: 'pw' });
    await expect(auth.logout()).resolves.toBeUndefined();

    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().status).toBe('anonymous');
  });

  it('signs out everywhere on request', async () => {
    const fetchMock = routedFetch({
      '/api/auth/logout-all': () => new Response(null, { status: 204 }),
    });
    const auth = authWith(fetchMock);

    await auth.logout({ everywhere: true });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/auth/logout-all'
    );
  });
});

describe('AuthClient proactive refresh', () => {
  it('schedules a refresh at 80 percent of the lifetime', async () => {
    const scheduled: { handler: () => void; ms: number }[] = [];
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a2', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, {
      disableProactiveRefresh: false,
      setTimeoutImpl: (handler, ms) => {
        scheduled.push({ handler, ms });
        return scheduled.length;
      },
      clearTimeoutImpl: () => undefined,
    });

    await auth.login({ email: 'a@b.test', password: 'pw' });

    // 600 seconds at 0.8 is 480 seconds.
    expect(scheduled.at(-1)?.ms).toBe(480_000);

    scheduled.at(-1)?.handler();
    await vi.waitFor(() => {
      expect(auth.getAccessToken()).toBe('a2');
    });
  });

  it('honours a custom ratio', async () => {
    const scheduled: number[] = [];
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 1000 }),
    });
    const auth = authWith(fetchMock, {
      disableProactiveRefresh: false,
      proactiveRefreshRatio: 0.5,
      setTimeoutImpl: (_handler, ms) => {
        scheduled.push(ms);
        return scheduled.length;
      },
      clearTimeoutImpl: () => undefined,
    });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    expect(scheduled.at(-1)).toBe(500_000);
  });

  it('schedules nothing when the server sent no lifetime', async () => {
    const scheduled: number[] = [];
    const fetchMock = routedFetch({
      '/api/auth/login': () => jsonResponse({ access_token: 'a1' }),
    });
    const auth = authWith(fetchMock, {
      disableProactiveRefresh: false,
      setTimeoutImpl: (_handler, ms) => {
        scheduled.push(ms);
        return scheduled.length;
      },
      clearTimeoutImpl: () => undefined,
    });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    expect(scheduled).toEqual([]);
  });

  it('cancels the timer on logout and on dispose', async () => {
    const cleared: unknown[] = [];
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const auth = authWith(fetchMock, {
      disableProactiveRefresh: false,
      setTimeoutImpl: () => 'handle',
      clearTimeoutImpl: (handle) => cleared.push(handle),
    });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    await auth.logout();
    expect(cleared).toContain('handle');

    // Disposing cancels again rather than leaving a timer holding the process
    // open, and leaves the client safe to read.
    auth.dispose();
    expect(auth.getState().status).toBe('anonymous');
  });
});

describe('AuthClient.startOAuth', () => {
  it('navigates to the provider start route', () => {
    const navigate = vi.fn();
    const auth = authWith(routedFetch({}), { navigate });

    auth.startOAuth('google', { returnTo: '/settings', mode: 'link' });

    expect(navigate).toHaveBeenCalledWith(
      'https://api.example.test/api/auth/oauth/google/start?return_to=%2Fsettings&mode=link'
    );
  });

  it('omits the query when nothing was passed', () => {
    const navigate = vi.fn();
    const auth = authWith(routedFetch({}), { navigate });

    auth.startOAuth('github');

    expect(navigate).toHaveBeenCalledWith(
      'https://api.example.test/api/auth/oauth/github/start'
    );
  });
});

describe('AuthClient passkeys', () => {
  it('logs in with a discoverable credential', async () => {
    const webAuthn = {
      create: vi.fn(),
      get: vi.fn(() => Promise.resolve({ id: 'cred_1' })),
    };
    const fetchMock = routedFetch({
      '/api/auth/login/webauthn/options': () =>
        jsonResponse({ challenge: 'c1', allowCredentials: [] }),
      '/api/auth/login/webauthn/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    });
    const auth = authWith(fetchMock, { webAuthn });

    const outcome = await auth.loginWithPasskey();

    expect(webAuthn.get).toHaveBeenCalledWith({
      challenge: 'c1',
      allowCredentials: [],
    });
    expect(outcome).toEqual({
      mfaRequired: false,
      user: ALICE,
      expiresIn: 600,
    });
    expect(auth.getAccessToken()).toBe('a1');
  });

  it('registers a passkey against the current session', async () => {
    const webAuthn = {
      create: vi.fn(() => Promise.resolve({ id: 'cred_1' })),
      get: vi.fn(),
    };
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/webauthn/register/options': () =>
        jsonResponse({ challenge: 'c1' }),
      '/api/auth/webauthn/register/verify': () => jsonResponse({ ok: true }),
    });
    const auth = authWith(fetchMock, { webAuthn });

    await auth.login({ email: 'a@b.test', password: 'pw' });
    await expect(auth.registerPasskey()).resolves.toEqual({ ok: true });

    const optionsCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/webauthn/register/options')
    );
    const headers = new Headers((optionsCall?.[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer a1');
  });

  it('refuses to register a passkey with no session', async () => {
    const auth = authWith(routedFetch({}), {
      webAuthn: { create: vi.fn(), get: vi.fn() },
    });

    await expect(auth.registerPasskey()).rejects.toBeInstanceOf(
      AuthSessionEndedError
    );
  });

  it('completes an MFA login with a passkey', async () => {
    const webAuthn = {
      create: vi.fn(),
      get: vi.fn(() => Promise.resolve({ id: 'cred_1' })),
    };
    const fetchMock = routedFetch({
      '/api/auth/login/webauthn/options': () =>
        jsonResponse({ challenge: 'c1' }),
      '/api/auth/login/webauthn/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    });
    const auth = authWith(fetchMock, { webAuthn });

    await auth.completePasskeyMfa({ ticket: 'tkt' });
    expect(auth.getAccessToken()).toBe('a1');

    const verifyCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/webauthn/verify')
    );
    expect(
      JSON.parse((verifyCall?.[1] as RequestInit).body as string)
    ).toMatchObject({ mfa_ticket: 'tkt' });
  });
});

describe('AuthClient subscriptions', () => {
  it('hands out a new state object per transition', async () => {
    // useSyncExternalStore compares snapshots by reference, so a mutation in
    // place would leave React on a stale render.
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock);
    const before = auth.getState();

    await auth.initialize();

    expect(auth.getState()).not.toBe(before);
  });

  it('stops notifying after unsubscribe', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock);
    const listener = vi.fn();
    auth.subscribe(listener)();

    await auth.initialize();
    expect(listener).not.toHaveBeenCalled();
  });

  it('drops every subscriber on dispose', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock);
    const listener = vi.fn();
    auth.subscribe(listener);

    auth.dispose();
    await auth.initialize();

    expect(listener).not.toHaveBeenCalled();
  });
});
