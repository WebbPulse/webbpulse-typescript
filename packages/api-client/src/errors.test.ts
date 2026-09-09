import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ApiNetworkError,
  ApiTimeoutError,
  formatApiErrorMessage,
  getWebbPulseError,
  isWebbPulseErrorBody,
  type WebbPulseErrorBody,
} from './errors.js';

/** The body `error_body` in `webbpulse.http` renders, at its minimum. */
const envelope = (
  overrides: Partial<WebbPulseErrorBody> = {}
): WebbPulseErrorBody => ({
  success: false,
  status: 404,
  message: 'No such build list.',
  request_id: 'req-1',
  ...overrides,
});

/** An `ApiError` carrying `body`, with the rest filled in plausibly. */
const apiError = (body: unknown, status = 404, requestId = 'hdr-1'): ApiError =>
  new ApiError({
    status,
    statusText: 'Not Found',
    body,
    url: 'https://api.test/build-lists/1',
    method: 'GET',
    requestId,
  });

describe('formatApiErrorMessage', () => {
  it('uses a string detail', () => {
    expect(formatApiErrorMessage({ detail: 'Not found' })).toBe('Not found');
  });

  it('joins FastAPI validation detail items', () => {
    const body = {
      detail: [
        {
          loc: ['body', 'email'],
          msg: 'value is not a valid email',
          type: 'x',
        },
        { loc: ['body', 'age'], msg: 'must be positive', type: 'y' },
      ],
    };
    expect(formatApiErrorMessage(body)).toBe(
      'value is not a valid email. must be positive'
    );
  });

  it('falls back to a message field', () => {
    expect(formatApiErrorMessage({ message: 'Rate limited' })).toBe(
      'Rate limited'
    );
  });

  it('accepts a bare string body', () => {
    expect(formatApiErrorMessage('Gateway timeout')).toBe('Gateway timeout');
  });

  it('returns the fallback for an unrecognised shape', () => {
    expect(formatApiErrorMessage({ weird: true }, 'fallback')).toBe('fallback');
  });

  it('returns the fallback for null', () => {
    expect(formatApiErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it('ignores an empty detail array', () => {
    expect(formatApiErrorMessage({ detail: [] }, 'fallback')).toBe('fallback');
  });
});

describe('ApiError', () => {
  const build = (status: number, body: unknown = { detail: 'boom' }) =>
    new ApiError({
      status,
      statusText: 'Error',
      body,
      url: 'https://api.example.com/x',
      method: 'GET',
      requestId: 'req-1',
    });

  it('is an Error and an ApiError', () => {
    const error = build(500);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ApiError');
  });

  it('derives its message from the body', () => {
    expect(build(404).message).toBe('boom');
  });

  it('falls back to the status when the body carries no message', () => {
    expect(build(503, {}).message).toBe('Request failed with status 503.');
  });

  it('carries status, body, url, method and request id', () => {
    const error = build(422, { detail: 'bad' });
    expect(error.status).toBe(422);
    expect(error.body).toEqual({ detail: 'bad' });
    expect(error.url).toBe('https://api.example.com/x');
    expect(error.method).toBe('GET');
    expect(error.requestId).toBe('req-1');
  });

  it('classifies statuses', () => {
    expect(build(401).isUnauthorized).toBe(true);
    expect(build(403).isUnauthorized).toBe(false);
    expect(build(404).isClientError).toBe(true);
    expect(build(500).isClientError).toBe(false);
    expect(build(502).isServerError).toBe(true);
    expect(build(404).isServerError).toBe(false);
  });
});

describe('ApiTimeoutError', () => {
  it('names the timeout when one elapsed', () => {
    const error = new ApiTimeoutError({
      url: 'https://api.example.com/x',
      method: 'GET',
      timeoutMs: 5000,
    });
    expect(error.message).toContain('timed out after 5000ms');
    expect(error).toBeInstanceOf(ApiTimeoutError);
  });

  it('reports a caller abort without a duration', () => {
    const error = new ApiTimeoutError({
      url: 'https://api.example.com/x',
      method: 'GET',
    });
    expect(error.message).toContain('was aborted');
    expect(error.timeoutMs).toBeUndefined();
  });
});

describe('ApiNetworkError', () => {
  it('keeps the underlying cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new ApiNetworkError({
      url: 'https://api.example.com/x',
      method: 'POST',
      cause,
    });
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect(error.cause).toBe(cause);
    expect(error.method).toBe('POST');
  });
});

describe('isWebbPulseErrorBody', () => {
  it('accepts the four field envelope', () => {
    expect(isWebbPulseErrorBody(envelope())).toBe(true);
  });

  it('accepts the envelope with the optional fields present', () => {
    expect(
      isWebbPulseErrorBody(
        envelope({ error_code: 'NOT_FOUND', details: { field: 'id' } })
      )
    ).toBe(true);
  });

  it('rejects a FastAPI detail body', () => {
    // The discriminant is `success: false`, which a `detail` body never sets.
    expect(isWebbPulseErrorBody({ detail: 'Not found' })).toBe(false);
  });

  it('rejects a bare message body', () => {
    expect(isWebbPulseErrorBody({ message: 'Nope' })).toBe(false);
  });

  it('rejects a success envelope', () => {
    expect(isWebbPulseErrorBody({ success: true, message: 'ok' })).toBe(false);
  });

  it('rejects a non object', () => {
    expect(isWebbPulseErrorBody(null)).toBe(false);
    expect(isWebbPulseErrorBody('Not found')).toBe(false);
    expect(isWebbPulseErrorBody(undefined)).toBe(false);
  });

  it('rejects an envelope whose message is not a string', () => {
    expect(isWebbPulseErrorBody({ success: false, message: 42 })).toBe(false);
  });

  it('accepts an envelope missing status and request_id', () => {
    // Deliberately permissive: a proxy that drops a key should not cost the
    // caller the message, which is the field that matters.
    expect(isWebbPulseErrorBody({ success: false, message: 'Gone' })).toBe(
      true
    );
  });
});

describe('formatApiErrorMessage with the WebbPulse envelope', () => {
  it('prefers the envelope message', () => {
    expect(formatApiErrorMessage(envelope())).toBe('No such build list.');
  });

  it('prefers the envelope message over a detail on the same body', () => {
    // Not a shape the backend produces, but the precedence has to be stated:
    // `message` is what `error_body` writes for a caller to read.
    expect(
      formatApiErrorMessage({ ...envelope(), detail: 'framework wording' })
    ).toBe('No such build list.');
  });

  it('falls through to the fallback when the envelope message is blank', () => {
    expect(formatApiErrorMessage(envelope({ message: '   ' }), 'fb')).toBe(
      'fb'
    );
  });

  it('still reads a FastAPI detail, unchanged', () => {
    expect(formatApiErrorMessage({ detail: 'Not found' })).toBe('Not found');
  });
});

describe('getWebbPulseError', () => {
  it('returns every envelope field, camel cased', () => {
    const error = apiError(
      envelope({
        error_code: 'BUILD_LIST_NOT_FOUND',
        details: [{ field: 'id', message: 'unknown' }],
      })
    );

    expect(getWebbPulseError(error)).toEqual({
      message: 'No such build list.',
      errorCode: 'BUILD_LIST_NOT_FOUND',
      details: [{ field: 'id', message: 'unknown' }],
      requestId: 'req-1',
      status: 404,
    });
  });

  it('leaves the optional fields undefined when the backend omitted them', () => {
    // A service that has not enabled `error_codes` or `validation_details`
    // sends the four base fields, and a `switch` on errorCode has to be able
    // to see that as one case rather than as a missing property.
    const info = getWebbPulseError(apiError(envelope()));
    expect(info.errorCode).toBeUndefined();
    expect(info.details).toBeUndefined();
    expect(info.message).toBe('No such build list.');
  });

  it('prefers the body request id over the header', () => {
    const info = getWebbPulseError(
      apiError(envelope({ request_id: 'body-9' }))
    );
    expect(info.requestId).toBe('body-9');
  });

  it('falls back to the header request id when the body has none', () => {
    const info = getWebbPulseError(apiError(envelope({ request_id: '' })));
    expect(info.requestId).toBe('hdr-1');
  });

  it('reads the status from the response, not the body', () => {
    // The two disagree only when something rewrote one of them, and the
    // response is the one the browser actually saw.
    const info = getWebbPulseError(apiError(envelope({ status: 500 }), 502));
    expect(info.status).toBe(502);
  });

  it('degrades to the formatted message for a FastAPI detail body', () => {
    const info = getWebbPulseError(apiError({ detail: 'Not found' }, 404));
    expect(info).toEqual({
      message: 'Not found',
      errorCode: undefined,
      details: undefined,
      requestId: 'hdr-1',
      status: 404,
    });
  });

  it('degrades to the generic message for an unreadable body', () => {
    const info = getWebbPulseError(apiError('<html>502</html>', 502));
    expect(info.message).toBe('<html>502</html>');
    expect(info.errorCode).toBeUndefined();
  });

  it('always yields a renderable message', () => {
    // The point of the accessor: a call site renders `.message` with no
    // fallback of its own, so it can never be empty.
    const bare = new ApiError({
      status: 500,
      statusText: 'Internal Server Error',
      body: null,
      url: 'https://api.test/x',
      method: 'GET',
    });
    const info = getWebbPulseError(bare);
    expect(info.message).toBe('Request failed with status 500.');
    expect(info.requestId).toBeUndefined();
  });
});
