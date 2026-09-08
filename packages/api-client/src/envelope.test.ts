import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client.js';
import { createEnvelopeClient, toEnvelope } from './envelope.js';
import { ApiError, ApiNetworkError } from './errors.js';

const BASE = 'https://api.example.test/api/v1';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A client whose fetch is a mock, so no network is involved. */
function clientWith(fetchImpl: typeof globalThis.fetch) {
  return createApiClient({ baseUrl: BASE, fetch: fetchImpl, retries: 0 });
}

describe('toEnvelope', () => {
  it('returns the data with no error on success', async () => {
    const result = await toEnvelope(() =>
      Promise.resolve({
        data: [{ id: 1 }],
        status: 200,
        headers: new Headers(),
        requestId: 'rid-1',
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.status).toBe(200);
    expect(result.requestId).toBe('rid-1');
  });

  it('converts an ApiError into the error field rather than throwing', async () => {
    const error = new ApiError({
      status: 404,
      statusText: 'Not Found',
      body: { detail: 'Project not found' },
      url: `${BASE}/projects/99`,
      method: 'GET',
      requestId: 'rid-2',
    });

    const result = await toEnvelope(() => Promise.reject(error));

    expect(result.data).toBeNull();
    expect(result.error).toBe('Project not found');
    expect(result.status).toBe(404);
    expect(result.requestId).toBe('rid-2');
    expect(result.cause).toBe(error);
  });

  it('unpacks a FastAPI validation detail array into one line', async () => {
    const error = new ApiError({
      status: 422,
      statusText: 'Unprocessable Entity',
      body: {
        detail: [
          { loc: ['body', 'title'], msg: 'field required', type: 'missing' },
        ],
      },
      url: `${BASE}/posts/`,
      method: 'POST',
    });

    const result = await toEnvelope(() => Promise.reject(error));

    expect(result.error).toBe('field required');
  });

  it('falls back to the ApiError message when the body carries nothing readable', async () => {
    const error = new ApiError({
      status: 500,
      statusText: 'Internal Server Error',
      body: { unexpected: true },
      url: `${BASE}/x`,
      method: 'GET',
    });

    const result = await toEnvelope(() => Promise.reject(error));

    expect(result.error).toBe('Request failed with status 500.');
  });

  it('carries a non ApiError through by its message', async () => {
    const error = new ApiNetworkError({ url: `${BASE}/x`, method: 'GET' });

    const result = await toEnvelope(() => Promise.reject(error));

    expect(result.data).toBeNull();
    expect(result.error).toBe(`Network request to ${BASE}/x failed.`);
    expect(result.status).toBeUndefined();
    expect(result.cause).toBe(error);
  });

  it('uses the fallback message for a thrown non Error value', async () => {
    // Deliberately not an Error. A consumer's own code can throw anything, and
    // the envelope has to stay an envelope rather than propagating it, so the
    // rule is off for this line specifically.
    const result = await toEnvelope<never>(
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'a string';
      },
      { fallbackMessage: 'Something went wrong.' }
    );

    expect(result.error).toBe('Something went wrong.');
    expect(result.cause).toBe('a string');
  });

  it('uses the fallback message for an Error with an empty message', async () => {
    const result = await toEnvelope(() => Promise.reject(new Error('')), {
      fallbackMessage: 'Something went wrong.',
    });

    expect(result.error).toBe('Something went wrong.');
  });

  it('uses a default message when no fallback is supplied', async () => {
    const result = await toEnvelope<never>(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    });

    expect(result.error).toBe('An unexpected error occurred.');
  });

  it('reports every failure through onError and nothing on success', async () => {
    const onError = vi.fn();

    await toEnvelope(() => Promise.reject(new Error('boom')), { onError });
    expect(onError).toHaveBeenCalledTimes(1);

    await toEnvelope(
      () =>
        Promise.resolve({
          data: 1,
          status: 200,
          headers: new Headers(),
          requestId: undefined,
        }),
      { onError }
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('catches a thunk that throws synchronously', async () => {
    const result = await toEnvelope<never>(() => {
      throw new Error('thrown before the request');
    });

    expect(result.data).toBeNull();
    expect(result.error).toBe('thrown before the request');
  });

  it('logs nothing of its own', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await toEnvelope(() => Promise.reject(new Error('boom')));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('createEnvelopeClient', () => {
  it('resolves rather than rejecting on a non 2xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ detail: 'Not authorised' }, { status: 401 })
      );
    const api = createEnvelopeClient(clientWith(fetchMock as never));

    const result = await api.get('/site-content/');

    expect(result.data).toBeNull();
    expect(result.error).toBe('Not authorised');
    expect(result.status).toBe(401);
  });

  it('returns the parsed body on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 1, title: 'One' }]));
    const api = createEnvelopeClient(clientWith(fetchMock as never));

    const result = await api.get<{ id: number; title: string }[]>('/projects/');

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([{ id: 1, title: 'One' }]);
  });

  it('exposes the throwing client it wraps', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'nope' }, { status: 400 }));
    const client = clientWith(fetchMock as never);
    const api = createEnvelopeClient(client);

    expect(api.client).toBe(client);
    await expect(api.client.get('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('passes bodies and options through on every verb', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const api = createEnvelopeClient(clientWith(fetchMock as never));

    await api.post('/posts/', { title: 'One' });
    await api.put('/posts/1', { title: 'Two' });
    await api.patch('/posts/1', { title: 'Three' });
    await api.delete('/posts/1');
    await api.request('GET', '/posts/', { query: { published: true } });

    const methods = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).method
    );
    expect(methods).toEqual(['POST', 'PUT', 'PATCH', 'DELETE', 'GET']);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ title: 'One' }),
    });
    expect(fetchMock.mock.calls[4]?.[0]).toBe(`${BASE}/posts/?published=true`);
  });

  it('binds a domain client to the prefix and keeps the options', async () => {
    const onError = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'gone' }, { status: 404 }));
    const api = createEnvelopeClient(clientWith(fetchMock as never), {
      onError,
    });

    const posts = api.createDomainClient('/posts');
    const result = await posts.get('/1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/posts/1`);
    expect(result.error).toBe('gone');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('preserves a trailing slash through the envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const api = createEnvelopeClient(clientWith(fetchMock as never));

    await api.get('/experience/');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/experience/`);
  });
});
