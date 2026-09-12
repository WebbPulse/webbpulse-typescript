import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import {
  LINK_TOKEN_PARAM,
  RESET_PASSWORD_PATH,
  VERIFY_EMAIL_PATH,
  readLinkToken,
  retryAfterSeconds,
} from './email-flows.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The envelope every WebbPulse backend renders on a non 2xx. */
function envelope(
  status: number,
  code: string | undefined,
  message = 'Denied.',
  details?: Record<string, unknown>
): Response {
  return jsonResponse(
    {
      success: false,
      status,
      message,
      request_id: 'req_test',
      ...(code === undefined ? {} : { error_code: code }),
      ...(details === undefined ? {} : { details }),
    },
    status
  );
}

/** A fetch stub routed by URL suffix, longest match first. */
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

function authWith(fetchMock: ReturnType<typeof vi.fn>): AuthClient {
  return createAuthClient({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    clientOptions: { fetch: fetchMock, retries: 0 },
  });
}

/** The body a route was called with, parsed. */
function bodyOf(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string
): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(suffix));
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;
}

describe('SPA link paths', () => {
  /**
   * These two literals are a contract across two repositories with nothing
   * enforcing it at build time, and a drift sends every mailed link to a 404.
   * `webbpulse-python` carries the mirror of this test.
   */
  it('match VERIFY_LINK_PATH and RESET_LINK_PATH on the backend', () => {
    expect(VERIFY_EMAIL_PATH).toBe('/verify-email');
    expect(RESET_PASSWORD_PATH).toBe('/reset-password');
    expect(LINK_TOKEN_PARAM).toBe('token');
  });

  it('is not the API confirm route', () => {
    expect(RESET_PASSWORD_PATH).not.toBe('/api/auth/reset/confirm');
  });
});

describe('readLinkToken', () => {
  it('reads the token out of a mailed URL', () => {
    expect(
      readLinkToken({ url: 'https://app.example.test/verify-email?token=abc' })
    ).toBe('abc');
  });

  it('handles a base64url token with - and _ unchanged', () => {
    const token = 'ab-cd_ef12';
    expect(
      readLinkToken({
        url: `https://app.example.test/reset-password?token=${token}`,
      })
    ).toBe(token);
  });

  it('returns null for a missing or empty token', () => {
    expect(
      readLinkToken({ url: 'https://app.example.test/verify-email' })
    ).toBe(null);
    expect(
      readLinkToken({ url: 'https://app.example.test/verify-email?token=' })
    ).toBe(null);
  });

  it('accepts a relative href', () => {
    expect(readLinkToken({ url: '/reset-password?token=t1' })).toBe('t1');
  });

  it('honours expectedPath, so one page cannot read the other flow token', () => {
    expect(
      readLinkToken({
        url: 'https://app.example.test/reset-password?token=t1',
        expectedPath: VERIFY_EMAIL_PATH,
      })
    ).toBe(null);
    expect(
      readLinkToken({
        url: 'https://app.example.test/reset-password?token=t1',
        expectedPath: RESET_PASSWORD_PATH,
      })
    ).toBe('t1');
  });

  it('ignores a trailing slash on the path', () => {
    expect(
      readLinkToken({
        url: 'https://app.example.test/reset-password/?token=t1',
        expectedPath: RESET_PASSWORD_PATH,
      })
    ).toBe('t1');
  });

  it('returns null rather than throwing with no location and no url', () => {
    const location = (globalThis as { location?: unknown }).location;
    // @ts-expect-error deleting a global for the duration of one assertion
    delete globalThis.location;
    try {
      expect(readLinkToken()).toBe(null);
    } finally {
      if (location !== undefined) {
        Object.defineProperty(globalThis, 'location', {
          value: location,
          configurable: true,
        });
      }
    }
  });

  it('reads the current location by default', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://app.example.test/verify-email?token=from-bar' },
      configurable: true,
      writable: true,
    });
    expect(readLinkToken({ expectedPath: VERIFY_EMAIL_PATH })).toBe('from-bar');
  });
});

describe('retryAfterSeconds', () => {
  it('reads a numeric hint out of the envelope details', () => {
    const error = new ApiError({
      status: 429,
      statusText: 'Too Many Requests',
      body: {
        success: false,
        status: 429,
        message: 'Too many requests.',
        request_id: 'r',
        details: { retry_after: 60 },
      },
      url: 'https://api.example.test/api/auth/reset',
      method: 'POST',
    });
    expect(retryAfterSeconds(error)).toBe(60);
  });

  it('is undefined for a non ApiError and for a body with no hint', () => {
    expect(retryAfterSeconds(new Error('network'))).toBeUndefined();
    const error = new ApiError({
      status: 429,
      statusText: 'Too Many Requests',
      body: { success: false, status: 429, message: 'No.', request_id: 'r' },
      url: 'https://api.example.test/api/auth/reset',
      method: 'POST',
    });
    expect(retryAfterSeconds(error)).toBeUndefined();
  });
});

describe('requestEmailVerification', () => {
  it('posts the address and resolves ok', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email': () => jsonResponse({ sent: true }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.requestEmailVerification({
      email: 'alice@example.test',
    });

    expect(outcome).toEqual({ ok: true, detail: undefined });
    expect(bodyOf(fetchMock, '/verify-email')).toEqual({
      email: 'alice@example.test',
    });
  });

  it('resolves identically for an unknown address', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email': () => jsonResponse({ sent: true }),
    });
    const auth = authWith(fetchMock);

    const known = await auth.requestEmailVerification({
      email: 'alice@example.test',
    });
    const unknown = await auth.requestEmailVerification({
      email: 'nobody@example.test',
    });

    expect(unknown).toEqual(known);
  });

  it('never retries, so one ask is one mail', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email': () => jsonResponse({ sent: true }),
    });
    const auth = authWith(fetchMock);

    await auth.requestEmailVerification({ email: 'alice@example.test' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns rate-limited on a 429 rather than throwing', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email': () =>
        envelope(429, undefined, 'Too many requests. Try again later.', {
          retry_after: 900,
        }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.requestEmailVerification({
      email: 'alice@example.test',
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'rate-limited',
      retryAfter: 900,
    });
  });

  it('returns unavailable when the deployment has no sender', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email': () =>
        envelope(503, 'EMAIL_NOT_CONFIGURED', 'Email is not configured.'),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.requestEmailVerification({
      email: 'alice@example.test',
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'unavailable',
      code: 'EMAIL_NOT_CONFIGURED',
    });
  });

  it('rethrows a 500 and a network failure', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/verify-email': () => envelope(500, undefined, 'Boom.'),
      })
    );
    await expect(
      auth.requestEmailVerification({ email: 'a@example.test' })
    ).rejects.toBeInstanceOf(ApiError);

    const offline = authWith(
      routedFetch({
        '/api/auth/verify-email': () => new Error('offline'),
      })
    );
    await expect(
      offline.requestEmailVerification({ email: 'a@example.test' })
    ).rejects.toThrow(/Network request .* failed/);
  });
});

describe('requestPasswordReset', () => {
  it("returns the server's section 5.4 sentence in detail", async () => {
    const detail = 'If that address has an account, a link is on its way.';
    const fetchMock = routedFetch({
      '/api/auth/reset': () => jsonResponse({ sent: true, detail }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.requestPasswordReset({
      email: 'alice@example.test',
    });

    expect(outcome).toEqual({ ok: true, detail });
    expect(bodyOf(fetchMock, '/api/auth/reset')).toEqual({
      email: 'alice@example.test',
    });
  });

  it('resolves identically for an unknown address', async () => {
    const detail = 'If that address has an account, a link is on its way.';
    const fetchMock = routedFetch({
      '/api/auth/reset': () => jsonResponse({ sent: true, detail }),
    });
    const auth = authWith(fetchMock);

    expect(
      await auth.requestPasswordReset({ email: 'nobody@example.test' })
    ).toEqual(await auth.requestPasswordReset({ email: 'alice@example.test' }));
  });

  it('returns rate-limited on the 3 per hour bucket', async () => {
    const fetchMock = routedFetch({
      '/api/auth/reset': () => envelope(429, undefined, 'Too many requests.'),
    });
    const auth = authWith(fetchMock);

    expect(
      await auth.requestPasswordReset({ email: 'alice@example.test' })
    ).toMatchObject({
      ok: false,
      reason: 'rate-limited',
      retryAfter: undefined,
    });
  });
});

describe('confirmEmailVerification', () => {
  it('posts the token and returns the user id', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email/confirm': () =>
        jsonResponse({ verified: true, user_id: 'u_1' }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.confirmEmailVerification({ token: 'tok' });

    expect(outcome).toEqual({ ok: true, userId: 'u_1' });
    expect(bodyOf(fetchMock, '/verify-email/confirm')).toEqual({
      token: 'tok',
    });
  });

  it('returns a null user id when the server omits one', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/verify-email/confirm': () =>
          jsonResponse({ verified: true }),
      })
    );
    expect(await auth.confirmEmailVerification({ token: 'tok' })).toEqual({
      ok: true,
      userId: null,
    });
  });

  it('returns invalid-link for INVALID_LINK rather than throwing', async () => {
    const message = 'This link is no longer valid. Request a new one.';
    const auth = authWith(
      routedFetch({
        '/api/auth/verify-email/confirm': () =>
          envelope(400, 'INVALID_LINK', message),
      })
    );

    const outcome = await auth.confirmEmailVerification({ token: 'spent' });

    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid-link',
      code: 'INVALID_LINK',
      message,
      retryAfter: undefined,
    });
  });

  it('gives one outcome for unknown, expired, spent and wrong purpose', async () => {
    const message = 'This link is no longer valid. Request a new one.';
    const outcomes = [];
    for (const _reason of ['unknown', 'expired', 'spent', 'wrong-purpose']) {
      const auth = authWith(
        routedFetch({
          '/api/auth/verify-email/confirm': () =>
            envelope(400, 'INVALID_LINK', message),
        })
      );
      outcomes.push(await auth.confirmEmailVerification({ token: 'x' }));
    }
    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
  });

  it('never retries, so a single use token is presented once', async () => {
    const fetchMock = routedFetch({
      '/api/auth/verify-email/confirm': () =>
        jsonResponse({ verified: true, user_id: 'u_1' }),
    });
    const auth = authWith(fetchMock);

    await auth.confirmEmailVerification({ token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a password code, which this route must never emit', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/verify-email/confirm': () =>
          envelope(400, 'PASSWORD_TOO_SHORT', 'Too short.'),
      })
    );
    await expect(
      auth.confirmEmailVerification({ token: 'tok' })
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('confirmPasswordReset', () => {
  it('posts the token and the snake case password field', async () => {
    const fetchMock = routedFetch({
      '/api/auth/reset/confirm': () => jsonResponse({ reset: true }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.confirmPasswordReset({
      token: 'tok',
      newPassword: 'a-long-enough-password',
    });

    expect(outcome).toEqual({ ok: true });
    expect(bodyOf(fetchMock, '/reset/confirm')).toEqual({
      token: 'tok',
      new_password: 'a-long-enough-password',
    });
  });

  it('sends family_ids only when given', async () => {
    const withIds = routedFetch({
      '/api/auth/reset/confirm': () => jsonResponse({ reset: true }),
    });
    await authWith(withIds).confirmPasswordReset({
      token: 't',
      newPassword: 'p'.repeat(16),
      familyIds: ['f1', 'f2'],
    });
    expect(bodyOf(withIds, '/reset/confirm')['family_ids']).toEqual([
      'f1',
      'f2',
    ]);

    const without = routedFetch({
      '/api/auth/reset/confirm': () => jsonResponse({ reset: true }),
    });
    await authWith(without).confirmPasswordReset({
      token: 't',
      newPassword: 'p'.repeat(16),
    });
    expect('family_ids' in bodyOf(without, '/reset/confirm')).toBe(false);
  });

  it('sends an empty family_ids list rather than dropping it', async () => {
    const fetchMock = routedFetch({
      '/api/auth/reset/confirm': () => jsonResponse({ reset: true }),
    });
    await authWith(fetchMock).confirmPasswordReset({
      token: 't',
      newPassword: 'p'.repeat(16),
      familyIds: [],
    });
    expect(bodyOf(fetchMock, '/reset/confirm')['family_ids']).toEqual([]);
  });

  it('drops the local session, because the reset revoked every family', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/reset/confirm': () => jsonResponse({ reset: true }),
    });
    const onSessionEnded = vi.fn();
    const auth = createAuthClient({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      clientOptions: { fetch: fetchMock, retries: 0 },
      onSessionEnded,
    });
    await auth.initialize();
    expect(auth.getAccessToken()).toBe('a1');

    await auth.confirmPasswordReset({
      token: 'tok',
      newPassword: 'p'.repeat(16),
    });

    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().status).toBe('anonymous');
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(auth.getState().sessionEnded?.reason).toBe('logged-out');
  });

  it('returns invalid-link for a spent link', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/reset/confirm': () =>
          envelope(400, 'INVALID_LINK', 'This link is no longer valid.'),
      })
    );
    expect(
      await auth.confirmPasswordReset({
        token: 'spent',
        newPassword: 'p'.repeat(16),
      })
    ).toMatchObject({ ok: false, reason: 'invalid-link' });
  });

  it.each([
    'PASSWORD_TOO_SHORT',
    'PASSWORD_TOO_LONG',
    'WEAK_PASSWORD',
    'PASSWORD_REJECTED',
  ])('returns password-rejected for %s', async (code) => {
    const auth = authWith(
      routedFetch({
        '/api/auth/reset/confirm': () => envelope(400, code, 'No good.'),
      })
    );

    const outcome = await auth.confirmPasswordReset({
      token: 'tok',
      newPassword: 'short',
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'password-rejected',
      code,
      message: 'No good.',
    });
  });

  it('keeps the session when the reset was refused', async () => {
    const fetchMock = routedFetch({
      '/api/auth/refresh': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
      '/api/auth/reset/confirm': () =>
        envelope(400, 'INVALID_LINK', 'No longer valid.'),
    });
    const auth = authWith(fetchMock);
    await auth.initialize();

    await auth.confirmPasswordReset({
      token: 'x',
      newPassword: 'p'.repeat(16),
    });

    expect(auth.getAccessToken()).toBe('a1');
  });

  it('returns rate-limited on a 429', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/reset/confirm': () =>
          envelope(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts.'),
      })
    );
    expect(
      await auth.confirmPasswordReset({
        token: 'tok',
        newPassword: 'p'.repeat(16),
      })
    ).toMatchObject({
      ok: false,
      reason: 'rate-limited',
      code: 'TOO_MANY_ATTEMPTS',
    });
  });

  it('rethrows a 500', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/reset/confirm': () => envelope(500, undefined, 'Boom.'),
      })
    );
    await expect(
      auth.confirmPasswordReset({ token: 't', newPassword: 'p'.repeat(16) })
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('path overrides', () => {
  it('lets a product mount the four routes elsewhere', async () => {
    const fetchMock = routedFetch({
      '/identity/verify': () => jsonResponse({ sent: true }),
    });
    const auth = createAuthClient({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      clientOptions: { fetch: fetchMock, retries: 0 },
      paths: { verifyEmail: '/identity/verify' },
    });

    await auth.requestEmailVerification({ email: 'a@example.test' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/identity/verify');
  });
});
