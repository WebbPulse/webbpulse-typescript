import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import { TOTP_FACTOR, classifyMfaError } from './mfa.js';

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
  message = 'That code is not valid.',
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

/** The request a route was called with. */
function callTo(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string
): RequestInit {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(suffix));
  if (call === undefined) {
    throw new Error(`${suffix} was never called`);
  }
  return call[1] as RequestInit;
}

function bodyOf(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string
): Record<string, unknown> {
  return JSON.parse(callTo(fetchMock, suffix).body as string) as Record<
    string,
    unknown
  >;
}

function headerOf(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string,
  name: string
): string | null {
  const headers = new Headers(callTo(fetchMock, suffix).headers);
  return headers.get(name);
}

/**
 * The token bodies the identity service actually writes, transcribed from the
 * M4 route tests in `webbpulse-python`.
 */
const LOGIN_TOKENS = {
  access_token: 'access-1',
  token_type: 'Bearer',
  expires_in: 600,
};

/** The exact enrolment body of `POST /api/auth/totp/enrol`. */
const ENROLMENT = {
  secret: 'JBSWY3DPEHPK3PXP',
  provisioning_uri:
    'otpauth://totp/WebbPulse:user@example.test?secret=JBSWY3DPEHPK3PXP&issuer=WebbPulse',
};

/** Ten codes, hyphen grouped, as `_generate_recovery_code` produces them. */
const RECOVERY_CODES = [
  'ABCDE-FGHIJ-KLMNO-PQRST',
  'BCDEF-GHIJK-LMNOP-QRSTU',
  'CDEFG-HIJKL-MNOPQ-RSTUV',
  'DEFGH-IJKLM-NOPQR-STUVW',
  'EFGHI-JKLMN-OPQRS-TUVWX',
  'FGHIJ-KLMNO-PQRST-UVWXY',
  'GHIJK-LMNOP-QRSTU-VWXYZ',
  'HIJKL-MNOPQ-RSTUV-WXYZ2',
  'IJKLM-NOPQR-STUVW-XYZ23',
  'JKLMN-OPQRS-TUVWX-YZ234',
];

/** Signs a client in so the authorized MFA routes have a bearer token. */
async function signedIn(
  routes: Parameters<typeof routedFetch>[0]
): Promise<{ auth: AuthClient; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = routedFetch({
    '/api/auth/login': () => jsonResponse(LOGIN_TOKENS),
    ...routes,
  });
  const auth = authWith(fetchMock);
  await auth.login({ email: 'user@example.test', password: 'pw' });
  return { auth, fetchMock };
}

describe('the login challenge', () => {
  /**
   * The single most load-bearing assertion across the two repositories. The
   * first leg answers 200 with a challenge rather than 401, because nothing was
   * refused: the password was correct. A client that read this as a failure
   * would leave every MFA user with no way to sign in.
   */
  it('is a successful outcome, not a rejection', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({
          mfa_required: true,
          mfa_ticket: 'ticket-1',
          factors: ['totp'],
        }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.login({
      email: 'user@example.test',
      password: 'pw',
    });

    expect(outcome.mfaRequired).toBe(true);
    if (!outcome.mfaRequired) {
      throw new Error('expected a challenge');
    }
    expect(outcome.ticket).toBe('ticket-1');
    expect(outcome.factors).toEqual([TOTP_FACTOR]);
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().pendingMfa).toEqual({
      ticket: 'ticket-1',
      factors: ['totp'],
    });
  });

  it('names the factor the backend names', () => {
    // Mirrors `TOTP_FACTOR` in `webbpulse.identity.mfa`, which is what appears
    // in the `factors` array and in the enrol route paths.
    expect(TOTP_FACTOR).toBe('totp');
  });

  it('is completed with the field name the route reads', async () => {
    // `mfa_ticket`, not `ticket`. A rename type-checks on both sides and breaks
    // every sign in, which is the class of failure this test exists to catch.
    const fetchMock = routedFetch({
      '/api/auth/login/totp': () => jsonResponse(LOGIN_TOKENS),
    });
    const auth = authWith(fetchMock);

    await auth.completeTotp({ ticket: 'ticket-1', code: '123456' });

    expect(bodyOf(fetchMock, '/api/auth/login/totp')).toEqual({
      mfa_ticket: 'ticket-1',
      code: '123456',
    });
    expect(auth.getAccessToken()).toBe('access-1');
  });
});

describe('enrolTotp', () => {
  it('returns the seed and the provisioning URI', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/enrol': () => jsonResponse(ENROLMENT),
    });

    const outcome = await auth.enrolTotp();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected an enrolment');
    }
    expect(outcome.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(outcome.provisioningUri).toBe(ENROLMENT.provisioning_uri);
    expect(outcome.provisioningUri.startsWith('otpauth://totp/')).toBe(true);
    expect(headerOf(fetchMock, '/api/auth/totp/enrol', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  it('does not retry, because a second call throws away the first seed', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/enrol': () => jsonResponse(ENROLMENT),
    });

    await auth.enrolTotp();

    const enrolCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/auth/totp/enrol')
    );
    expect(enrolCalls).toHaveLength(1);
  });

  it('reports an active factor as already-enabled rather than throwing', async () => {
    // 409 TOTP_ALREADY_ENABLED. The server refuses rather than replacing a
    // working authenticator, and the remedy is disable then enrol.
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () =>
        envelope(
          409,
          'TOTP_ALREADY_ENABLED',
          'TOTP is already enabled for this account.'
        ),
    });

    const outcome = await auth.enrolTotp();

    expect(outcome).toEqual({
      ok: false,
      reason: 'already-enabled',
      code: 'TOTP_ALREADY_ENABLED',
      message: 'TOTP is already enabled for this account.',
    });
  });

  it('reports the ten per hour enrolment limit', async () => {
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () =>
        envelope(429, undefined, 'Too many requests.', { retry_after: 300 }),
    });

    const outcome = await auth.enrolTotp();

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== 'rate-limited') {
      throw new Error('expected a rate limit');
    }
    expect(outcome.retryAfter).toBe(300);
  });

  it('leaves the session state alone on a refusal', async () => {
    // A wrong code or a 409 is not a session ending. The client stays
    // authenticated and nothing lands in `state.error` for a page level
    // boundary to render.
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () => envelope(409, 'TOTP_ALREADY_ENABLED'),
    });

    await auth.enrolTotp();

    expect(auth.getState().status).toBe('authenticated');
    expect(auth.getState().error).toBeNull();
    expect(auth.getAccessToken()).toBe('access-1');
  });

  it('rethrows a 500, which no form can render', async () => {
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () => envelope(500, undefined, 'Boom.'),
    });

    await expect(auth.enrolTotp()).rejects.toThrow();
  });

  it('rethrows a 401, because that is the session ending and not a bad code', async () => {
    // NOT_AUTHENTICATED means the bearer token is gone. api-client has already
    // tried one refresh and one replay by the time this arrives, so turning it
    // into a form field error would hide a session that ended.
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () =>
        envelope(401, 'NOT_AUTHENTICATED', 'Sign in first.'),
      '/api/auth/refresh': () => envelope(401, 'SESSION_REVOKED'),
    });

    await expect(auth.enrolTotp()).rejects.toThrow();
  });
});

describe('activateTotp', () => {
  it('sends the code and returns the recovery codes', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/activate': () =>
        jsonResponse({ activated: true, recovery_codes: RECOVERY_CODES }),
    });

    const outcome = await auth.activateTotp({ code: '123456' });

    expect(bodyOf(fetchMock, '/api/auth/totp/activate')).toEqual({
      code: '123456',
    });
    expect(outcome).toEqual({ ok: true, recoveryCodes: RECOVERY_CODES });
  });

  it('returns the ten codes the server issues', async () => {
    // RECOVERY_CODE_COUNT is ten in `webbpulse.identity.mfa`. The count is not
    // enforced here, but a set that came back short would be a wire bug worth
    // seeing in a test that reads the real body.
    const { auth } = await signedIn({
      '/api/auth/totp/activate': () =>
        jsonResponse({ activated: true, recovery_codes: RECOVERY_CODES }),
    });

    const outcome = await auth.activateTotp({ code: '123456' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected an activation');
    }
    expect(outcome.recoveryCodes).toHaveLength(10);
  });

  it('reports a wrong code as one refusal, whatever was wrong with it', async () => {
    // The server answers with one failure for every reason: wrong, replayed,
    // no factor, an inactive factor. Splitting it here would be inventing
    // information the client does not have.
    const { auth } = await signedIn({
      '/api/auth/totp/activate': () =>
        envelope(401, 'INVALID_MFA_CODE', 'That code is not valid.'),
    });

    const outcome = await auth.activateTotp({ code: '000000' });

    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid-code',
      code: 'INVALID_MFA_CODE',
      message: 'That code is not valid.',
    });
  });

  it('reports a stale form as no-pending-enrolment', async () => {
    const { auth } = await signedIn({
      '/api/auth/totp/activate': () =>
        envelope(
          409,
          'NO_PENDING_ENROLMENT',
          'There is no pending TOTP enrolment for this account.'
        ),
    });

    const outcome = await auth.activateTotp({ code: '123456' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('no-pending-enrolment');
  });

  it('reports the ten per fifteen minutes verify limit', async () => {
    const { auth } = await signedIn({
      '/api/auth/totp/activate': () => envelope(429, undefined),
    });

    const outcome = await auth.activateTotp({ code: '123456' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== 'rate-limited') {
      throw new Error('expected a rate limit');
    }
    // The limiter sends the wait in a Retry-After header, which ApiError does
    // not keep, so this is undefined more often than not.
    expect(outcome.retryAfter).toBeUndefined();
  });
});

describe('disableTotp', () => {
  it('posts nothing when no code is given, because the route wants none', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/disable': () => jsonResponse({ disabled: true }),
    });

    const outcome = await auth.disableTotp();

    expect(bodyOf(fetchMock, '/api/auth/totp/disable')).toEqual({});
    expect(outcome).toEqual({ ok: true });
    expect(headerOf(fetchMock, '/api/auth/totp/disable', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  it('passes a code through when a caller supplies one', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/disable': () => jsonResponse({ disabled: true }),
    });

    await auth.disableTotp({ code: '123456' });

    expect(bodyOf(fetchMock, '/api/auth/totp/disable')).toEqual({
      code: '123456',
    });
  });

  it('treats an empty code as no code', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/disable': () => jsonResponse({ disabled: true }),
    });

    await auth.disableTotp({ code: '' });

    expect(bodyOf(fetchMock, '/api/auth/totp/disable')).toEqual({});
  });
});

describe('regenerateRecoveryCodes', () => {
  it('returns the fresh set, which replaced the old one', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/recovery-codes': () =>
        jsonResponse({ recovery_codes: RECOVERY_CODES }),
    });

    const outcome = await auth.regenerateRecoveryCodes();

    expect(outcome).toEqual({ ok: true, recoveryCodes: RECOVERY_CODES });
    expect(bodyOf(fetchMock, '/api/auth/recovery-codes')).toEqual({});
  });

  it('rethrows an INVALID_MFA_CODE, which this route cannot legitimately send', async () => {
    // The route takes no code at all, so a code refusal arriving from it is a
    // server bug. Modelling it would let a bug become a rendered form state.
    const { auth } = await signedIn({
      '/api/auth/recovery-codes': () => envelope(401, 'INVALID_MFA_CODE'),
      '/api/auth/refresh': () => envelope(401, 'SESSION_REVOKED'),
    });

    await expect(auth.regenerateRecoveryCodes()).rejects.toThrow();
  });
});

describe('stepUp', () => {
  it('adopts the fresher access token into the in-memory store', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/step-up': () =>
        jsonResponse({
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 600,
        }),
    });

    const outcome = await auth.stepUp({ code: '123456' });

    expect(outcome).toEqual({ ok: true, expiresIn: 600 });
    expect(auth.getAccessToken()).toBe('access-2');
    expect(bodyOf(fetchMock, '/api/auth/step-up')).toEqual({ code: '123456' });
    expect(auth.getState().status).toBe('authenticated');
  });

  it('carries the current bearer token, since it acts inside a session', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/step-up': () =>
        jsonResponse({ access_token: 'access-2', expires_in: 600 }),
    });

    await auth.stepUp({ code: '123456' });

    expect(headerOf(fetchMock, '/api/auth/step-up', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  it('accepts a recovery code, because the server tells them apart by shape', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/step-up': () =>
        jsonResponse({ access_token: 'access-2', expires_in: 600 }),
    });

    await auth.stepUp({ code: 'ABCDE-FGHIJ-KLMNO-PQRST' });

    expect(bodyOf(fetchMock, '/api/auth/step-up')).toEqual({
      code: 'ABCDE-FGHIJ-KLMNO-PQRST',
    });
  });

  it('keeps the old token on a wrong code', async () => {
    // A refused step-up is not a session ending. The user is still signed in
    // with the token they had, and the only thing they lost is the elevation.
    const { auth } = await signedIn({
      '/api/auth/step-up': () =>
        envelope(401, 'INVALID_MFA_CODE', 'That code is not valid.'),
    });

    const outcome = await auth.stepUp({ code: '000000' });

    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid-code',
      code: 'INVALID_MFA_CODE',
      message: 'That code is not valid.',
    });
    expect(auth.getAccessToken()).toBe('access-1');
    expect(auth.getState().status).toBe('authenticated');
  });

  it('rejects a response with no token rather than reporting success', async () => {
    const { auth } = await signedIn({
      '/api/auth/step-up': () => jsonResponse({ token_type: 'Bearer' }),
    });

    await expect(auth.stepUp({ code: '123456' })).rejects.toThrow(
      /no access token/
    );
  });

  it('reports MFA_NOT_CONFIGURED as unavailable rather than as a bad code', async () => {
    // A deployment fault. The user can do nothing about it and "that code is
    // wrong" would be a lie.
    const { auth } = await signedIn({
      '/api/auth/step-up': () =>
        envelope(
          503,
          'MFA_NOT_CONFIGURED',
          'Multi-factor authentication is not available.'
        ),
    });

    const outcome = await auth.stepUp({ code: '123456' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('unavailable');
  });
});

describe('paths', () => {
  it('default to the issuer path the standard fixes', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/totp/enrol': () => jsonResponse(ENROLMENT),
      '/api/auth/totp/activate': () =>
        jsonResponse({ activated: true, recovery_codes: RECOVERY_CODES }),
      '/api/auth/totp/disable': () => jsonResponse({ disabled: true }),
      '/api/auth/recovery-codes': () =>
        jsonResponse({ recovery_codes: RECOVERY_CODES }),
      '/api/auth/step-up': () =>
        jsonResponse({ access_token: 'access-2', expires_in: 600 }),
    });

    await auth.enrolTotp();
    await auth.activateTotp({ code: '123456' });
    await auth.disableTotp();
    await auth.regenerateRecoveryCodes();
    await auth.stepUp({ code: '123456' });

    const called = fetchMock.mock.calls.map(
      (c) => new URL(String(c[0])).pathname
    );
    expect(called).toContain('/api/auth/totp/enrol');
    expect(called).toContain('/api/auth/totp/activate');
    expect(called).toContain('/api/auth/totp/disable');
    expect(called).toContain('/api/auth/recovery-codes');
    expect(called).toContain('/api/auth/step-up');
  });

  it('are overridable for an issuer mounted somewhere else', async () => {
    // An issuer with no path gives origin routes, which is the other shape the
    // router supports.
    const fetchMock = routedFetch({
      '/totp/enrol': () => jsonResponse(ENROLMENT),
    });
    const auth = createAuthClient({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      paths: { totpEnrol: '/totp/enrol' },
      clientOptions: { fetch: fetchMock, retries: 0 },
    });

    await auth.enrolTotp();

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/totp/enrol'
    );
  });
});

describe('classifyMfaError', () => {
  it('returns null for anything that is not an ApiError', () => {
    expect(
      classifyMfaError(new Error('offline'), new Set(['invalid-code'] as const))
    ).toBeNull();
  });

  it('returns null for a code the calling route does not model', async () => {
    // The guard that stops a refusal from one route becoming a silent success
    // on another.
    const { auth } = await signedIn({
      '/api/auth/totp/enrol': () => envelope(409, 'NO_PENDING_ENROLMENT'),
    });

    await expect(auth.enrolTotp()).rejects.toThrow();
  });
});
