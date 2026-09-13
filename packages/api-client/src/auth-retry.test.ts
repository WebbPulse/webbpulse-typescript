/**
 * The 401 retry pipeline. The auth client is stubbed, both because this package
 * must not depend on `@webbpulse/auth` and because a stub is the only way to
 * count the rotations a burst of concurrent 401s produces.
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
 * A stub auth provider with a real single-flight refresh, so the concurrent case
 * asserts what a real client would do. `refreshCalls` counts rotations rather
 * than callers.
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
    expect(bearerOn(fetchMock, 0)).toBe('Bearer expired');
    expect(bearerOn(fetchMock, 1)).toBe('Bearer fresh');
  });

  it('throws on a second 401 without refreshing again', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(unauthorized()));
    const auth = stubAuth({ tokens: ['expired', 'fresh'] });
    const client = clientWith(fetchMock, { auth });

    await expect(client.get('/widgets')).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.refreshCalls).toBe(1);
  });

  it('replays a POST, which the transport retry would never do', async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe('token source precedence', () => {
  it('reads the auth client rather than getAuthToken', async () => {
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

describe('ApiClient waitForToken', () => {
  it('awaits the provider rather than reading the token synchronously', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    let settle!: () => void;
    const arrived = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const auth: AuthTokenProvider = {
      getAccessToken: () => null,
      refresh: () => Promise.resolve(null),
      waitForToken: async () => {
        await arrived;
        return 'late-token';
      },
    };
    const client = clientWith(fetchMock, { auth });

    const call = client.get('/widgets');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    settle();
    await call;

    expect(bearerOn(fetchMock, 0)).toBe('Bearer late-token');
  });

  it('falls back to the synchronous read for a provider without it', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const auth = stubAuth({ tokens: ['t1'] });
    expect('waitForToken' in auth).toBe(false);

    await clientWith(fetchMock, { auth }).get('/widgets');
    expect(bearerOn(fetchMock, 0)).toBe('Bearer t1');
  });

  it('sends no bearer header when the wait resolves to no token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const auth: AuthTokenProvider = {
      getAccessToken: () => null,
      refresh: () => Promise.resolve(null),
      waitForToken: () => Promise.resolve(null),
    };

    await clientWith(fetchMock, { auth }).get('/public');
    expect(bearerOn(fetchMock, 0)).toBeNull();
  });
});
