import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, REQUEST_ID_HEADER, createApiClient } from './client.js';
import { ApiError, ApiNetworkError, ApiTimeoutError } from './errors.js';

const BASE = 'https://api.example.com';

/** Builds a Response with a JSON body. */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** A fetch stub that replays a queue of results, one per call. */
function stubFetch(results: (Response | Error)[]): typeof globalThis.fetch {
  let index = 0;
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve((result as Response).clone());
  });
}

function client(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}
): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    retries: 0,
    retryBaseDelayMs: 0,
    generateRequestId: () => 'fixed-request-id',
    ...overrides,
  });
}

describe('ApiClient requests', () => {
  it('performs a GET and parses JSON', async () => {
    const fetchImpl = stubFetch([jsonResponse({ id: 1, name: 'Tyler' })]);
    const result = await client(fetchImpl).get<{ id: number; name: string }>(
      '/users/1'
    );
    expect(result.data).toEqual({ id: 1, name: 'Tyler' });
    expect(result.status).toBe(200);
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`${BASE}/users/1`);
  });

  it('appends a serialised query string', async () => {
    const fetchImpl = stubFetch([jsonResponse([])]);
    await client(fetchImpl).get('/parts', {
      query: { ids: [1, 2], q: 'rotor' },
    });
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`${BASE}/parts?ids=1&ids=2&q=rotor`);
  });

  it('omits the question mark when the query is empty', async () => {
    const fetchImpl = stubFetch([jsonResponse([])]);
    await client(fetchImpl).get('/parts', { query: {} });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(`${BASE}/parts`);
  });

  it('JSON encodes a plain object body and sets the content type', async () => {
    const fetchImpl = stubFetch([jsonResponse({ ok: true }, { status: 201 })]);
    await client(fetchImpl).post('/parts', { name: 'rotor' });
    const init = vi.mocked(fetchImpl).mock.calls[0]![1]!;
    expect(init.body).toBe('{"name":"rotor"}');
    expect((init.headers as Headers).get('content-type')).toBe(
      'application/json'
    );
  });

  it('passes URLSearchParams through without forcing a content type', async () => {
    const fetchImpl = stubFetch([jsonResponse({ access_token: 't' })]);
    const body = new URLSearchParams({ username: 'a', password: 'b' });
    await client(fetchImpl).post('/auth/token', body);
    const init = vi.mocked(fetchImpl).mock.calls[0]![1]!;
    expect(init.body).toBe(body);
    expect((init.headers as Headers).get('content-type')).toBeNull();
  });

  it('sends credentials by default, for the staging access gate cookies', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl).get('/x');
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]!.credentials).toBe('include');
  });

  it('returns undefined data for a 204', async () => {
    const fetchImpl = stubFetch([new Response(null, { status: 204 })]);
    const result = await client(fetchImpl).delete('/parts/1');
    expect(result.data).toBeUndefined();
    expect(result.status).toBe(204);
  });

  it('returns text for a non JSON body', async () => {
    const fetchImpl = stubFetch([
      new Response('plain words', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ]);
    const result = await client(fetchImpl).get<string>('/health');
    expect(result.data).toBe('plain words');
  });

  it('resolves the raw Response when raw is set', async () => {
    const fetchImpl = stubFetch([jsonResponse({ a: 1 })]);
    const result = await client(fetchImpl).get<Response>('/x', { raw: true });
    expect(result.data).toBeInstanceOf(Response);
  });
});

describe('request id passthrough', () => {
  it('sends a generated request id header', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl).get('/x');
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get(REQUEST_ID_HEADER)).toBe('fixed-request-id');
  });

  it('sends a caller supplied request id instead', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl).get('/x', { requestId: 'caller-id' });
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get(REQUEST_ID_HEADER)).toBe('caller-id');
  });

  it('surfaces the request id the API echoed back', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { headers: { [REQUEST_ID_HEADER]: 'server-id' } }),
    ]);
    const result = await client(fetchImpl).get('/x');
    expect(result.requestId).toBe('server-id');
  });

  it('carries the request id on a thrown ApiError', async () => {
    const fetchImpl = stubFetch([
      jsonResponse(
        { detail: 'nope' },
        { status: 404, headers: { [REQUEST_ID_HEADER]: 'server-id' } }
      ),
    ]);
    await expect(client(fetchImpl).get('/x')).rejects.toMatchObject({
      status: 404,
      requestId: 'server-id',
    });
  });

  it('keeps one request id across retries of the same logical call', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({ detail: 'down' }, { status: 503 }),
      jsonResponse({ ok: true }),
    ]);
    await client(fetchImpl, { retries: 1 }).get('/x');
    const calls = vi.mocked(fetchImpl).mock.calls;
    const first = (calls[0]![1]!.headers as Headers).get(REQUEST_ID_HEADER);
    const second = (calls[1]![1]!.headers as Headers).get(REQUEST_ID_HEADER);
    expect(first).toBe(second);
    expect((calls[1]![1]!.headers as Headers).get('x-retry-attempt')).toBe('1');
  });
});

describe('error handling', () => {
  it('throws ApiError with the parsed body for a 4xx', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({ detail: 'Part not found' }, { status: 404 }),
    ]);
    await expect(client(fetchImpl).get('/parts/9')).rejects.toThrowError(
      ApiError
    );
    await expect(client(fetchImpl).get('/parts/9')).rejects.toMatchObject({
      status: 404,
      body: { detail: 'Part not found' },
      message: 'Part not found',
    });
  });

  it('throws ApiNetworkError when fetch itself rejects', async () => {
    const fetchImpl = stubFetch([new TypeError('Failed to fetch')]);
    await expect(client(fetchImpl).get('/x')).rejects.toThrowError(
      ApiNetworkError
    );
  });

  it('calls onUnauthorized for a 401', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = stubFetch([
      jsonResponse({ detail: 'no' }, { status: 401 }),
    ]);
    await expect(
      client(fetchImpl, { onUnauthorized }).get('/users/me')
    ).rejects.toThrowError(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onUnauthorized.mock.calls[0]![0]).toBeInstanceOf(ApiError);
  });

  it('does not call onUnauthorized for other statuses', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = stubFetch([jsonResponse({}, { status: 403 })]);
    await expect(
      client(fetchImpl, { onUnauthorized }).get('/x')
    ).rejects.toThrowError(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('auth headers', () => {
  it('sends a bearer token when one is available', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl, { getAuthToken: () => 'abc123' }).get('/x');
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer abc123');
  });

  it('omits the header when there is no token', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl, { getAuthToken: () => null }).get('/x');
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
  });

  it('rejects an async getAuthToken rather than sending a promise', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await expect(
      client(fetchImpl, {
        getAuthToken: (() => Promise.resolve('tok')) as unknown as () => string,
      }).get('/x')
    ).rejects.toThrowError(TypeError);
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it('reports a token the API rotated in through a response header', async () => {
    const onTokenRefresh = vi.fn();
    const fetchImpl = stubFetch([
      jsonResponse({}, { headers: { 'x-new-access-token': 'rotated' } }),
    ]);
    await client(fetchImpl, { onTokenRefresh }).get('/x');
    expect(onTokenRefresh).toHaveBeenCalledWith('rotated');
  });

  it('lets a per request header override a client default', async () => {
    const fetchImpl = stubFetch([jsonResponse({})]);
    await client(fetchImpl, { headers: { 'x-app': 'base' } }).get('/x', {
      headers: { 'x-app': 'override' },
    });
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('x-app')).toBe('override');
  });
});

describe('retry', () => {
  it('retries an idempotent GET on a 503 and then succeeds', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({ detail: 'down' }, { status: 503 }),
      jsonResponse({ ok: true }),
    ]);
    const result = await client(fetchImpl, { retries: 2 }).get<{
      ok: boolean;
    }>('/x');
    expect(result.data).toEqual({ ok: true });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure', async () => {
    const fetchImpl = stubFetch([
      new TypeError('Failed to fetch'),
      jsonResponse({ ok: true }),
    ]);
    await client(fetchImpl, { retries: 1 }).get('/x');
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const fetchImpl = stubFetch([jsonResponse({}, { status: 500 })]);
    await expect(
      client(fetchImpl, { retries: 2 }).get('/x')
    ).rejects.toThrowError(ApiError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx the caller owns', async () => {
    const fetchImpl = stubFetch([jsonResponse({}, { status: 404 })]);
    await expect(
      client(fetchImpl, { retries: 3 }).get('/x')
    ).rejects.toThrowError(ApiError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('retries a 429', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { status: 429 }),
      jsonResponse({ ok: true }),
    ]);
    await client(fetchImpl, { retries: 1 }).get('/x');
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('surfaces a delta-seconds Retry-After on a thrown 429', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '90' } }),
    ]);
    const error = await client(fetchImpl)
      .get('/x')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfterSeconds).toBe(90);
  });

  it('surfaces an HTTP-date Retry-After on a thrown 503', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:28:00Z'));
    try {
      const fetchImpl = stubFetch([
        jsonResponse(
          {},
          {
            status: 503,
            headers: { 'retry-after': 'Wed, 21 Oct 2026 07:29:00 GMT' },
          }
        ),
      ]);
      const error = await client(fetchImpl)
        .post('/x', {})
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).retryAfterSeconds).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves retryAfterSeconds undefined when no header was sent', async () => {
    const fetchImpl = stubFetch([jsonResponse({}, { status: 429 })]);
    const error = await client(fetchImpl)
      .get('/x')
      .catch((thrown: unknown) => thrown);
    expect((error as ApiError).retryAfterSeconds).toBeUndefined();
  });

  it('does not surface a Retry-After on a status that is not retryable', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { status: 404, headers: { 'retry-after': '90' } }),
    ]);
    const error = await client(fetchImpl)
      .get('/x')
      .catch((thrown: unknown) => thrown);
    expect((error as ApiError).retryAfterSeconds).toBeUndefined();
  });

  it('never retries a POST, which is not idempotent', async () => {
    const fetchImpl = stubFetch([jsonResponse({}, { status: 503 })]);
    await expect(
      client(fetchImpl, { retries: 3 }).post('/x', {})
    ).rejects.toThrowError(ApiError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('honours a per request retry override', async () => {
    const fetchImpl = stubFetch([jsonResponse({}, { status: 500 })]);
    await expect(
      client(fetchImpl, { retries: 5 }).get('/x', { retries: 0 })
    ).rejects.toThrowError(ApiError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('backs off between attempts', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { status: 503 }),
      jsonResponse({ ok: true }),
    ]);
    const started = Date.now();
    await client(fetchImpl, { retries: 1, retryBaseDelayMs: 40 }).get('/x');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });
});

describe('timeout and abort', () => {
  it('throws ApiTimeoutError when the timeout elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    ) as unknown as typeof globalThis.fetch;

    await expect(
      client(fetchImpl, { timeoutMs: 20, retries: 0 }).get('/slow')
    ).rejects.toThrowError(ApiTimeoutError);
  });

  it('aborts when the caller signal fires and does not retry', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    ) as unknown as typeof globalThis.fetch;

    const promise = client(fetchImpl, { retries: 3, timeoutMs: 0 }).get('/x', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrowError(ApiTimeoutError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('does not time out when timeoutMs is 0', async () => {
    const fetchImpl = stubFetch([jsonResponse({ ok: true })]);
    const result = await client(fetchImpl, { timeoutMs: 0 }).get<{
      ok: boolean;
    }>('/x');
    expect(result.data).toEqual({ ok: true });
  });
});

describe('createDomainClient', () => {
  let base: ApiClient;

  beforeEach(() => {
    base = client(stubFetch([jsonResponse({})]));
  });

  it('appends the prefix to the shared base URL', () => {
    expect(base.createDomainClient('/build-lists').baseUrl).toBe(
      `${BASE}/build-lists`
    );
  });

  it('accepts a prefix without a leading slash', () => {
    expect(base.createDomainClient('parts').baseUrl).toBe(`${BASE}/parts`);
  });

  it('returns an equivalent base URL for an empty prefix', () => {
    expect(base.createDomainClient('').baseUrl).toBe(BASE);
  });

  it('resolves request paths against the prefix', async () => {
    const fetchImpl = stubFetch([jsonResponse([])]);
    const parts = client(fetchImpl).createDomainClient('/parts');
    await parts.get('/search', { query: { q: 'rotor' } });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(
      `${BASE}/parts/search?q=rotor`
    );
  });

  it('inherits auth, credentials and the retry policy from the parent', async () => {
    const fetchImpl = stubFetch([
      jsonResponse({}, { status: 503 }),
      jsonResponse({ ok: true }),
    ]);
    const parent = client(fetchImpl, {
      retries: 1,
      getAuthToken: () => 'tok',
    });
    await parent.createDomainClient('/parts').get('/1');
    const headers = vi.mocked(fetchImpl).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('nests, so a domain can subdivide further', () => {
    expect(
      base.createDomainClient('/build-lists').createDomainClient('/parts')
        .baseUrl
    ).toBe(`${BASE}/build-lists/parts`);
  });
});

describe('createApiClient', () => {
  it('builds an ApiClient and trims a trailing slash from the base', () => {
    const created = createApiClient({ baseUrl: `${BASE}/` });
    expect(created).toBeInstanceOf(ApiClient);
    expect(created.baseUrl).toBe(BASE);
  });
});

describe('http verbs', () => {
  it.each([
    ['put', 'PUT'],
    ['patch', 'PATCH'],
  ] as const)('%s issues a %s', async (method, expected) => {
    const fetchImpl = stubFetch([jsonResponse({ ok: true })]);
    await client(fetchImpl)[method]('/x', { a: 1 });
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]!.method).toBe(expected);
  });

  it('delete issues a DELETE', async () => {
    const fetchImpl = stubFetch([new Response(null, { status: 204 })]);
    await client(fetchImpl).delete('/x');
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]!.method).toBe('DELETE');
  });
});
