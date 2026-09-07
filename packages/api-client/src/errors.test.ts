import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ApiNetworkError,
  ApiTimeoutError,
  formatApiErrorMessage,
} from './errors.js';

describe('formatApiErrorMessage', () => {
  it('uses a string detail', () => {
    expect(formatApiErrorMessage({ detail: 'Not found' })).toBe('Not found');
  });

  it('joins FastAPI validation detail items', () => {
    const body = {
      detail: [
        { loc: ['body', 'email'], msg: 'value is not a valid email', type: 'x' },
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
