import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ApiNetworkError,
  ApiTimeoutError,
  formatApiErrorMessage,
  getWebbPulseError,
  isWebbPulseErrorBody,
  parseRetryAfter,
  retryAfterFromHeaders,
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

describe('parseRetryAfter', () => {
  it('reads the delta-seconds form', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads a zero wait', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRetryAfter('  30  ')).toBe(30);
  });

  it('reads the HTTP-date form against the supplied clock', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:30:00 GMT', now)).toBe(120);
  });

  it('rounds a fractional HTTP-date wait up', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:01 GMT', now + 500)).toBe(1);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:02 GMT', now + 500)).toBe(2);
  });

  it('floors an HTTP-date already in the past at zero', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:30:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(0);
  });

  it('returns undefined for an absent header', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty or unparseable value', () => {
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('refuses a signed or fractional delta rather than coercing it', () => {
    expect(parseRetryAfter('-5')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter('12abc')).toBeUndefined();
  });
});

describe('retryAfterFromHeaders', () => {
  const headersWith = (value: string | null): Headers => {
    const headers = new Headers();
    if (value !== null) {
      headers.set('retry-after', value);
    }
    return headers;
  };

  it('reads the header on a 429', () => {
    expect(retryAfterFromHeaders(429, headersWith('45'))).toBe(45);
  });

  it('reads the header on a 503', () => {
    expect(retryAfterFromHeaders(503, headersWith('5'))).toBe(5);
  });

  it('ignores the header on a status that is not retryable', () => {
    expect(retryAfterFromHeaders(404, headersWith('45'))).toBeUndefined();
    expect(retryAfterFromHeaders(400, headersWith('45'))).toBeUndefined();
  });

  it('returns undefined when a retryable status carried no header', () => {
    expect(retryAfterFromHeaders(429, headersWith(null))).toBeUndefined();
  });
});

describe('ApiError.retryAfterSeconds', () => {
  it('carries the value it was constructed with', () => {
    const error = new ApiError({
      status: 429,
      statusText: 'Too Many Requests',
      body: envelope({ status: 429, message: 'Slow down.' }),
      url: 'https://api.test/x',
      method: 'GET',
      retryAfterSeconds: 60,
    });
    expect(error.retryAfterSeconds).toBe(60);
  });

  it('is undefined when the field was not supplied', () => {
    expect(apiError(envelope()).retryAfterSeconds).toBeUndefined();
  });
});
