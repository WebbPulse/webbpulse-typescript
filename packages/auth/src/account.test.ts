import { describe, expect, it, vi, type Mock } from 'vitest';

import { VERIFY_EMAIL_CHANGE_PATH, parseAccountSessions } from './account.js';
import { createAuthClient, type AuthClient } from './auth-client.js';

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

/** The envelope `webbpulse.http.error_body` renders on every refusal. */
function envelope(
  status: number,
  code: string | undefined,
  message = 'Refused.',
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
  [pathSuffix: string]: (init: RequestInit) => Response | Error;
}): Mock {
  return vi.fn((url: string | URL, init: RequestInit = {}) => {
    const href = typeof url === 'string' ? url : url.href;
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((suffix) => href.includes(suffix));
    if (key === undefined) {
      return Promise.reject(new Error(`No route stubbed for ${href}`));
    }
    const result = routes[key]!(init);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
}

/** A client signed in over the stub, so the account routes carry a bearer. */
async function signedIn(routes: {
  [pathSuffix: string]: (init: RequestInit) => Response | Error;
}): Promise<{ auth: AuthClient<User>; fetchMock: Mock }> {
  const fetchMock = routedFetch({
    '/api/auth/login': () =>
      jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    ...routes,
  });
  const auth = createAuthClient<User>({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    clientOptions: { fetch: fetchMock, retries: 0 },
  });
  await auth.login({ email: ALICE.email, password: 'pw' });
  return { auth, fetchMock };
}

/** The request init of the last call whose URL ends with `suffix`. */
function lastCall(fetchMock: Mock, suffix: string): RequestInit {
  const calls = fetchMock.mock.calls.filter((entry) =>
    String(entry[0]).endsWith(suffix)
  );
  const call = calls[calls.length - 1];
  if (call === undefined) {
    throw new Error(`No call to ${suffix}`);
  }
  return call[1] as RequestInit;
}

const SESSION = {
  id: 'fam_1',
  device: 'desktop',
  ip: '203.0.113.1',
  started_at: '2026-10-01T00:00:00+00:00',
  last_active_at: '2026-10-02T00:00:00+00:00',
  expires_at: 1790000000,
  amr: ['pwd'],
  current: true,
};

describe('VERIFY_EMAIL_CHANGE_PATH', () => {
  it('matches the backend EMAIL_CHANGE_LINK_PATH', () => {
    expect(VERIFY_EMAIL_CHANGE_PATH).toBe('/verify-email-change');
  });
});

describe('parseAccountSessions', () => {
  it('reads the wire shape into camel case', () => {
    expect(parseAccountSessions({ sessions: [SESSION] })).toEqual([
      {
        id: 'fam_1',
        device: 'desktop',
        ip: '203.0.113.1',
        startedAt: '2026-10-01T00:00:00+00:00',
        lastActiveAt: '2026-10-02T00:00:00+00:00',
        expiresAt: 1790000000,
        amr: ['pwd'],
        current: true,
      },
    ]);
  });

  it('drops entries with no id and survives an unexpected body', () => {
    expect(parseAccountSessions({ sessions: [{}, null, 'x'] })).toEqual([]);
    expect(parseAccountSessions(null)).toEqual([]);
    expect(
      parseAccountSessions({ sessions: [{ id: 'f', amr: [1, 'otp'] }] })
    ).toEqual([
      {
        id: 'f',
        device: '',
        ip: '',
        startedAt: '',
        lastActiveAt: '',
        expiresAt: null,
        amr: ['otp'],
        current: false,
      },
    ]);
  });
});

describe('AuthClient.listSessions', () => {
  it('lists the sessions with the bearer token', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/sessions': () => jsonResponse({ sessions: [SESSION] }),
    });

    const outcome = await auth.listSessions();

    expect(outcome.ok).toBe(true);
    expect(outcome.sessions.map((session) => session.id)).toEqual(['fam_1']);
    const headers = new Headers(
      lastCall(fetchMock, '/api/auth/sessions').headers
    );
    expect(headers.get('authorization')).toBe('Bearer a1');
  });

  it('throws when the session ended', async () => {
    const { auth } = await signedIn({
      '/api/auth/sessions': () => envelope(401, 'NOT_AUTHENTICATED'),
    });
    await expect(auth.listSessions()).rejects.toThrow();
  });
});

describe('AuthClient.revokeSession', () => {
  it('deletes the item path', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/sessions/fam_2': () => jsonResponse({ revoked: true }),
    });

    expect(await auth.revokeSession('fam_2')).toEqual({ ok: true });
    expect(lastCall(fetchMock, '/api/auth/sessions/fam_2').method).toBe(
      'DELETE'
    );
  });

  it('models an unknown session and the current one', async () => {
    const missing = await signedIn({
      '/api/auth/sessions/fam_9': () => envelope(404, 'SESSION_NOT_FOUND'),
    });
    expect(await missing.auth.revokeSession('fam_9')).toMatchObject({
      ok: false,
      reason: 'not-found',
      code: 'SESSION_NOT_FOUND',
    });

    const current = await signedIn({
      '/api/auth/sessions/fam_1': () => envelope(400, 'CURRENT_SESSION'),
    });
    expect(await current.auth.revokeSession('fam_1')).toMatchObject({
      ok: false,
      reason: 'current-session',
    });
  });

  it('rethrows a refusal it does not model', async () => {
    const { auth } = await signedIn({
      '/api/auth/sessions/fam_2': () => envelope(500, undefined),
    });
    await expect(auth.revokeSession('fam_2')).rejects.toThrow();
  });
});

describe('AuthClient.requestEmailChange', () => {
  it('posts the new address with the bearer token', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/email/change': () => jsonResponse({ sent: true }),
    });

    expect(
      await auth.requestEmailChange({ email: 'new@example.test' })
    ).toEqual({ ok: true });
    const init = lastCall(fetchMock, '/api/auth/email/change');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'new@example.test',
    });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer a1');
  });

  it.each([
    ['INVALID_EMAIL', 400, 'invalid-email'],
    ['EMAIL_UNCHANGED', 400, 'unchanged'],
    ['EMAIL_TAKEN', 409, 'taken'],
    ['EMAIL_CHANGE_UNSUPPORTED', 501, 'unavailable'],
    ['EMAIL_NOT_CONFIGURED', 503, 'unavailable'],
  ] as const)('models %s as %s', async (code, status, reason) => {
    const { auth } = await signedIn({
      '/api/auth/email/change': () => envelope(status, code),
    });
    expect(
      await auth.requestEmailChange({ email: 'new@example.test' })
    ).toMatchObject({ ok: false, reason });
  });

  it('carries the step-up window', async () => {
    const { auth } = await signedIn({
      '/api/auth/email/change': () =>
        envelope(401, 'STEP_UP_REQUIRED', 'Confirm it is you.', {
          max_age: 600,
        }),
    });
    expect(
      await auth.requestEmailChange({ email: 'new@example.test' })
    ).toMatchObject({ ok: false, reason: 'step-up-required', maxAge: 600 });
  });

  it('models a rate limit', async () => {
    const { auth } = await signedIn({
      '/api/auth/email/change': () => envelope(429, 'RATE_LIMITED'),
    });
    expect(
      await auth.requestEmailChange({ email: 'new@example.test' })
    ).toMatchObject({ ok: false, reason: 'rate-limited' });
  });
});

describe('AuthClient.confirmEmailChange', () => {
  it('posts the token without a bearer', async () => {
    const fetchMock = routedFetch({
      '/api/auth/email/change/confirm': () => jsonResponse({ changed: true }),
    });
    const auth = createAuthClient<User>({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      clientOptions: { fetch: fetchMock, retries: 0 },
    });

    expect(await auth.confirmEmailChange({ token: 't1' })).toEqual({
      ok: true,
    });
    const init = lastCall(fetchMock, '/api/auth/email/change/confirm');
    expect(JSON.parse(init.body as string)).toEqual({ token: 't1' });
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('models a spent link and an address claimed since', async () => {
    const spent = await signedIn({
      '/api/auth/email/change/confirm': () => envelope(400, 'INVALID_LINK'),
    });
    expect(await spent.auth.confirmEmailChange({ token: 't' })).toMatchObject({
      ok: false,
      reason: 'invalid-link',
    });

    const taken = await signedIn({
      '/api/auth/email/change/confirm': () => envelope(409, 'EMAIL_TAKEN'),
    });
    expect(await taken.auth.confirmEmailChange({ token: 't' })).toMatchObject({
      ok: false,
      reason: 'taken',
    });
  });
});
