/**
 * The 401 retry pipeline of section 7.2 of the identity standard.
 *
 * The auth client is stubbed rather than imported: this package must not depend
 * on `@webbpulse/auth`, and the contract it actually relies on is the narrow
 * `AuthTokenProvider`. A stub is also the only way to assert that exactly one
 * refresh happened for a burst of concurrent 401s, since a real client would
 * hide that behind its own single flight.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createApiClient,
  type ApiClientOptions,
  type AuthTokenProvider,
} from './client.js';
import { ApiError } from './errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized(): Response {
  return jsonResponse(
    {
      success: false,
      status: 401,
      message: 'Token has expired.',
      request_id: 'req_test',
      error_code: 'TOKEN_EXPIRED',
    },
    401
  );
}

/**
 * A stub auth provider with a real single-flight refresh.
 *
 * The single flight is the behaviour under test on the auth side, and it is
 * reproduced here so the concurrent case asserts what a real client would do.
 * `refreshCalls` counts the actual rotations, not the number of callers.
 */
function stubAuth(options: {
  tokens: (string | null)[];
  onRefresh?: () => void;
}): AuthTokenProvider & { refreshCalls: number; current: string | null } {
  let index = 0;
  let inFlight: Promise<string | null> | null = null;
  const state = {
    refreshCalls: 0,
    current: options.tokens[0] ?? null,
    getAccessToken(): string | null {
      return state.current;
    },
    refresh(): Promise<string | null> {
      if (inFlight !== null) {
        return inFlight;
      }
      state.refreshCalls += 1;
      options.onRefresh?.();
      inFlight = (async () => {
        // A microtask, so concurrent callers genuinely overlap.
        await Promise.resolve();
        index += 1;
        const next = options.tokens[index] ?? null;
        state.current = next;
        inFlight = null;
        return next;
      })();
      return inFlight;
    },
  };
  return state;
}

function clientWith(
  fetchMock: ReturnType<typeof vi.fn>,
  extra: Partial<ApiClientOptions> = {}
): ReturnType<typeof createApiClient> {
  return createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: fetchMock,
    retries: 0,
    ...extra,
  });
}

/** URL of the nth fetch call. */
function urlOn(fetchMock: ReturnType<typeof vi.fn>, n: number): string {
  return String(fetchMock.mock.calls[n]?.[0]);
}

/** Bearer token on the nth fetch call, or null when none was sent. */
function bearerOn(
  fetchMock: ReturnType<typeof vi.fn>,
  n: number
): string | null {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
  if (init === undefined) {
    return null;
  }
  return new Headers(init.headers).get('authorization');
}

describe('401 refresh and replay', () => {
  it('refreshes once and replays the request once', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? unauthorized() : jsonResponse({ ok: true })
      );
    });
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.get('/widgets')).resolves.toMatchObject({
      data: { ok: true },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.refreshCalls).toBe(1);
    // The replay carries the new token, not the one that just failed.
    expect(bearerOn(fetchMock, 0)).toBe('Bearer expired');
    expect(bearerOn(fetchMock, 1)).toBe('Bearer fresh');
  });

  it('throws on a second 401 without refreshing again', async () => {
    // The classic interceptor bug is that the replay's 401 starts another
    // refresh, and one expired token becomes an infinite loop.
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.get('/widgets')).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.refreshCalls).toBe(1);
  });

  it('replays a POST, which the transport retry would never do', async () => {
    // The transport refuses to retry an unsafe method, and rightly. A 401
    // replay is a different case: the first attempt was rejected before it
    // reached the handler, so nothing happened that a replay would repeat.
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? unauthorized() : jsonResponse({ id: 'w_1' }, 201)
      );
    });
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.post('/widgets', { name: 'x' })).resolves.toMatchObject(
      { status: 201 }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up when the refresh reports the session is gone', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const auth = stubAuth({ tokens: ['expired', null] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.get('/widgets')).rejects.toBeInstanceOf(ApiError);

    // One attempt only. There is no token to replay with.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.refreshCalls).toBe(1);
  });

  it('leaves a non 401 alone', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ detail: 'nope' }, 403))
    );
    const auth = stubAuth({ tokens: ['t1', 't2'] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.get('/widgets')).rejects.toBeInstanceOf(ApiError);
    expect(auth.refreshCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for a request whose caller aborted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(() => {
      controller.abort();
      return Promise.resolve(unauthorized());
    });
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(
      client.get('/widgets', { signal: controller.signal })
    ).rejects.toBeInstanceOf(ApiError);
    expect(auth.refreshCalls).toBe(0);
  });

  it('honours skipAuthRetry, which the identity routes set', async () => {
    // `/api/auth/refresh` cannot refresh itself, and a 401 from
    // `/api/auth/login` means the password was wrong.
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(
      client.post('/api/auth/refresh', undefined, { skipAuthRetry: true })
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.refreshCalls).toBe(0);
  });

  it('behaves exactly as before when no auth client is configured', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const onUnauthorized = vi.fn();
    const client = clientWith(fetchMock, {
      getAuthToken: () => 'legacy',
      onUnauthorized,
    });

    await expect(client.get('/widgets')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(bearerOn(fetchMock, 0)).toBe('Bearer legacy');
  });
});

describe('concurrent 401s', () => {
  it('trigger exactly one refresh across every in-flight request', async () => {
    // This is the frontend half of the concurrency problem in 2.6. Ten
    // rotations for ten parallel requests would look like refresh token reuse,
    // and the server would revoke the family and sign the user out of a
    // perfectly good session.
    const seen: string[] = [];
    const fetchMock = vi.fn((_url: string | URL, init: RequestInit = {}) => {
      const bearer = new Headers(init.headers).get('authorization') ?? '';
      seen.push(bearer);
      return Promise.resolve(
        bearer === 'Bearer fresh' ? jsonResponse({ ok: true }) : unauthorized()
      );
    });
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        client.get(`/widgets/${String(i)}`)
      )
    );

    expect(auth.refreshCalls).toBe(1);
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.data).toEqual({ ok: true });
    }
    // Ten first attempts with the expired token, ten replays with the new one.
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(seen.filter((b) => b === 'Bearer fresh')).toHaveLength(10);
  });

  it('fail together when the shared refresh fails, with one refresh', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const auth = stubAuth({ tokens: ['expired', null] });
    const client = clientWith(fetchMock, { auth });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, i) =>
        client.get(`/widgets/${String(i)}`)
      )
    );

    expect(auth.refreshCalls).toBe(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // Eight first attempts and no replays, because there is no token.
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe('token source precedence', () => {
  it('reads the auth client rather than getAuthToken', async () => {
    // The auth client holds the token a refresh replaces, so the older source
    // would attach a stale one.
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const auth = stubAuth({ tokens: ['from-auth-client'] });
    const client = clientWith(fetchMock, {
      auth,
      getAuthToken: () => 'from-legacy-store',
    });

    await client.get('/widgets');
    expect(bearerOn(fetchMock, 0)).toBe('Bearer from-auth-client');
  });

  it('sends no bearer header when the auth client has no token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const auth = stubAuth({ tokens: [null] });
    const client = clientWith(fetchMock, { auth });

    await client.get('/public');
    expect(bearerOn(fetchMock, 0)).toBeNull();
  });

  it('carries the auth client through createDomainClient', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const auth = stubAuth({ tokens: ['t1'] });
    const domain = clientWith(fetchMock, { auth }).createDomainClient(
      '/build-lists'
    );

    await domain.get('/');
    expect(bearerOn(fetchMock, 0)).toBe('Bearer t1');
    expect(urlOn(fetchMock, 0)).toBe('https://api.example.test/build-lists/');
  });
});
