/**
 * The step-up challenge: a 401 that asks for a recent sign-in rather than
 * saying the session is gone, and so must bypass the refresh and replay.
 */

import { describe, expect, it, vi } from 'vitest';

import { createApiClient, type AuthTokenProvider } from './client.js';
import {
  ApiError,
  STEP_UP_REQUIRED_ERROR_CODE,
  StepUpRequiredError,
  apiErrorFromResponse,
  getWebbPulseError,
  isStepUpRequired,
} from './errors.js';

function stepUpResponse(
  options: { maxAge?: number; header?: string | null; code?: string } = {}
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.header !== null) {
    headers['www-authenticate'] =
      options.header ??
      `Bearer error="insufficient_user_authentication", error_description="A more recent authentication is required", max_age=${String(options.maxAge ?? 300)}`;
  }
  return new Response(
    JSON.stringify({
      success: false,
      status: 401,
      message: 'Confirm it is you to continue.',
      request_id: 'req_step',
      error_code: options.code ?? STEP_UP_REQUIRED_ERROR_CODE,
      ...(options.maxAge === undefined ? {} : { max_age: options.maxAge }),
    }),
    { status: 401, headers }
  );
}

function expiredResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      status: 401,
      message: 'Token has expired.',
      request_id: 'req_expired',
      error_code: 'TOKEN_EXPIRED',
    }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}

function stubAuth(): AuthTokenProvider & {
  refreshSpy: ReturnType<typeof vi.fn>;
} {
  const refreshSpy = vi.fn(() => Promise.resolve('token-2'));
  return {
    getAccessToken: () => 'token-1',
    refresh: refreshSpy,
    refreshSpy,
  };
}

const init = {
  status: 401,
  statusText: 'Unauthorized',
  url: 'https://api.example.test/x',
  method: 'POST',
};

function headers(value?: string): { get(name: string): string | null } {
  return {
    get: (name: string) =>
      name === 'www-authenticate' && value !== undefined ? value : null,
  };
}

describe('apiErrorFromResponse', () => {
  it('builds a StepUpRequiredError from the envelope code and max_age', () => {
    const error = apiErrorFromResponse(
      {
        ...init,
        body: {
          success: false,
          status: 401,
          message: 'Step up.',
          request_id: 'r',
          error_code: 'STEP_UP_REQUIRED',
          max_age: 600,
        },
      },
      headers()
    );
    expect(error).toBeInstanceOf(StepUpRequiredError);
    expect(error).toBeInstanceOf(ApiError);
    expect(isStepUpRequired(error)).toBe(true);
    expect((error as StepUpRequiredError).maxAge).toBe(600);
    expect(error.isUnauthorized).toBe(false);
    expect(error.status).toBe(401);
    expect(getWebbPulseError(error).errorCode).toBe('STEP_UP_REQUIRED');
  });

  it('falls back to the header max_age when the body has none', () => {
    const error = apiErrorFromResponse(
      {
        ...init,
        body: {
          success: false,
          status: 401,
          message: 'Step up.',
          request_id: 'r',
          error_code: 'STEP_UP_REQUIRED',
        },
      },
      headers('Bearer error="insufficient_user_authentication", max_age=120')
    );
    expect((error as StepUpRequiredError).maxAge).toBe(120);
  });

  it('recognises the header alone, for a body a proxy replaced', () => {
    const error = apiErrorFromResponse(
      { ...init, body: 'Unauthorized' },
      headers('Bearer error="insufficient_user_authentication", max_age="45"')
    );
    expect(isStepUpRequired(error)).toBe(true);
    expect((error as StepUpRequiredError).maxAge).toBe(45);
  });

  it('leaves maxAge undefined when neither source carries a usable one', () => {
    const error = apiErrorFromResponse(
      {
        ...init,
        body: {
          success: false,
          status: 401,
          message: 'Step up.',
          request_id: 'r',
          error_code: 'STEP_UP_REQUIRED',
          max_age: -5,
        },
      },
      headers()
    );
    expect(isStepUpRequired(error)).toBe(true);
    expect((error as StepUpRequiredError).maxAge).toBeUndefined();
  });

  it('keeps an ordinary 401 a plain ApiError', () => {
    const error = apiErrorFromResponse(
      {
        ...init,
        body: {
          success: false,
          status: 401,
          message: 'Expired.',
          request_id: 'r',
          error_code: 'TOKEN_EXPIRED',
        },
      },
      headers('Bearer error="invalid_token"')
    );
    expect(isStepUpRequired(error)).toBe(false);
    expect(error.isUnauthorized).toBe(true);
  });

  it('ignores the code on a status other than 401', () => {
    const error = apiErrorFromResponse(
      {
        ...init,
        status: 403,
        body: {
          success: false,
          status: 403,
          message: 'No.',
          request_id: 'r',
          error_code: 'STEP_UP_REQUIRED',
        },
      },
      headers()
    );
    expect(isStepUpRequired(error)).toBe(false);
  });

  it('isStepUpRequired rejects non errors', () => {
    expect(isStepUpRequired(null)).toBe(false);
    expect(isStepUpRequired(new Error('x'))).toBe(false);
  });
});

describe('the client on a step-up challenge', () => {
  it('neither refreshes nor replays, and throws StepUpRequiredError', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(stepUpResponse({ maxAge: 300 }))
    );
    const auth = stubAuth();
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 0,
      auth,
      onUnauthorized,
    });

    const error: unknown = await client
      .post('/workspaces/1/destroy', {})
      .catch((thrown: unknown) => thrown);

    expect(isStepUpRequired(error)).toBe(true);
    expect((error as StepUpRequiredError).maxAge).toBe(300);
    expect(auth.refreshSpy).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is not retried by the transport on an idempotent method', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(stepUpResponse()));
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 2,
      retryBaseDelayMs: 0,
    });

    await expect(client.get('/secrets')).rejects.toBeInstanceOf(
      StepUpRequiredError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still refreshes and replays an ordinary expired-token 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(expiredResponse())
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const auth = stubAuth();
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 0,
      auth,
      onUnauthorized,
    });

    const response = await client.post('/x', {});
    expect(response.data).toEqual({ ok: true });
    expect(auth.refreshSpy).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('surfaces a step-up challenge met on the replay after a refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(expiredResponse())
      .mockResolvedValueOnce(stepUpResponse({ maxAge: 60 }));
    const auth = stubAuth();
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 0,
      auth,
    });

    const error: unknown = await client
      .post('/x', {})
      .catch((thrown: unknown) => thrown);
    expect(isStepUpRequired(error)).toBe(true);
    expect(auth.refreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads the challenge without the header, from the body alone', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(stepUpResponse({ maxAge: 90, header: null }))
    );
    const auth = stubAuth();
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 0,
      auth,
    });

    const error: unknown = await client
      .delete('/x')
      .catch((thrown: unknown) => thrown);
    expect((error as StepUpRequiredError).maxAge).toBe(90);
    expect(auth.refreshSpy).not.toHaveBeenCalled();
  });
});
