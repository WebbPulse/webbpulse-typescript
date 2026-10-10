import { createHash } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import {
  DESKTOP_HANDOFF_PAGE_PATH,
  createDesktopHandoffPkce,
  desktopHandoffCallbackUrl,
  desktopHandoffChallenge,
  desktopHandoffLaunchUrl,
  isHandoffSchemeAllowed,
  normaliseHandoffAllowlist,
  normaliseHandoffScheme,
  readDesktopHandoffCallback,
  readDesktopHandoffRequest,
} from './desktop-handoff.js';

const ALLOWED = ['exampleapp', 'exampleapp-staging'] as const;
const ORIGIN = 'https://app.example.test';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(status: number, code: string | undefined): Response {
  return jsonResponse(
    {
      success: false,
      status,
      message: 'Denied.',
      request_id: 'req_test',
      ...(code === undefined ? {} : { error_code: code }),
    },
    status
  );
}

function routedFetch(routes: { [pathSuffix: string]: () => Response }): Mock {
  return vi.fn((url: string | URL) => {
    const href = typeof url === 'string' ? url : url.href;
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((suffix) => href.endsWith(suffix));
    const handler = key === undefined ? undefined : routes[key];
    if (handler === undefined) {
      return Promise.reject(new Error(`No route stubbed for ${href}`));
    }
    return Promise.resolve(handler());
  });
}

function authWith(
  fetchMock: Mock,
  schemes: readonly string[] = ALLOWED
): AuthClient<{ id: string }> {
  return createAuthClient<{ id: string }>({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    desktopHandoffSchemes: schemes,
    clientOptions: { fetch: fetchMock, retries: 0 },
  });
}

function callTo(fetchMock: Mock, suffix: string): RequestInit {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith(suffix));
  return (call?.[1] ?? {}) as RequestInit;
}

function bodyOf(fetchMock: Mock, suffix: string): Record<string, unknown> {
  return JSON.parse(callTo(fetchMock, suffix).body as string) as Record<
    string,
    unknown
  >;
}

async function signedIn(fetchMock: Mock): Promise<AuthClient<{ id: string }>> {
  const auth = authWith(fetchMock);
  await auth.login({ email: 'person@example.test', password: 'pw' });
  return auth;
}

describe('scheme allowlist', () => {
  it('normalises the way the server does', () => {
    expect(normaliseHandoffScheme(' ExampleApp:// ')).toBe('exampleapp');
    expect(normaliseHandoffScheme('exampleapp:')).toBe('exampleapp');
  });

  it('allows only listed custom schemes', () => {
    expect(isHandoffSchemeAllowed('exampleapp', ALLOWED)).toBe(true);
    expect(isHandoffSchemeAllowed('EXAMPLEAPP://', ALLOWED)).toBe(true);
    expect(isHandoffSchemeAllowed('otherapp', ALLOWED)).toBe(false);
    expect(isHandoffSchemeAllowed('exampleapp', [])).toBe(false);
  });

  it('never allows a web scheme, even when listed', () => {
    expect(isHandoffSchemeAllowed('https', ['https'])).toBe(false);
    expect(isHandoffSchemeAllowed('javascript', ['javascript'])).toBe(false);
  });

  it('throws on a web or malformed allowlist entry', () => {
    expect(() => normaliseHandoffAllowlist(['https'])).toThrow();
    expect(() => normaliseHandoffAllowlist(['1app'])).toThrow();
    expect(() => normaliseHandoffAllowlist(['my app'])).toThrow();
    expect(normaliseHandoffAllowlist(['ExampleApp://', 'exampleapp'])).toEqual([
      'exampleapp',
    ]);
  });

  it('makes createAuthClient throw on a web scheme', () => {
    expect(() =>
      createAuthClient({
        baseUrl: 'https://api.example.test',
        desktopHandoffSchemes: ['http'],
      })
    ).toThrow();
  });
});

describe('PKCE', () => {
  it('derives the RFC 7636 appendix B challenge', async () => {
    expect(await desktopHandoffChallenge(VERIFIER)).toBe(CHALLENGE);
  });

  it('creates a 43 character verifier with a matching S256 challenge', async () => {
    const pkce = await createDesktopHandoffPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.method).toBe('S256');
    expect(pkce.challenge).toBe(
      createHash('sha256').update(pkce.verifier).digest('base64url')
    );
  });

  it('creates a different verifier each time', async () => {
    const a = await createDesktopHandoffPkce();
    const b = await createDesktopHandoffPkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('launch URL', () => {
  it('round trips through readDesktopHandoffRequest', () => {
    const url = desktopHandoffLaunchUrl({
      origin: ORIGIN,
      challenge: CHALLENGE,
      scheme: 'ExampleApp',
      allowedSchemes: ALLOWED,
    });
    expect(new URL(url).pathname).toBe(DESKTOP_HANDOFF_PAGE_PATH);
    expect(readDesktopHandoffRequest(url, ALLOWED)).toEqual({
      challenge: CHALLENGE,
      scheme: 'exampleapp',
    });
  });

  it('refuses to build for a scheme off the allowlist', () => {
    expect(() =>
      desktopHandoffLaunchUrl({
        origin: ORIGIN,
        challenge: CHALLENGE,
        scheme: 'otherapp',
        allowedSchemes: ALLOWED,
      })
    ).toThrow();
  });

  it('reads null for an unknown scheme, a web scheme or a bad challenge', () => {
    const base = `${ORIGIN}${DESKTOP_HANDOFF_PAGE_PATH}`;
    expect(
      readDesktopHandoffRequest(
        `${base}?code_challenge=${CHALLENGE}&scheme=otherapp`,
        ALLOWED
      )
    ).toBe(null);
    expect(
      readDesktopHandoffRequest(
        `${base}?code_challenge=${CHALLENGE}&scheme=https`,
        [...ALLOWED, 'https']
      )
    ).toBe(null);
    expect(
      readDesktopHandoffRequest(
        `${base}?code_challenge=short&scheme=exampleapp`,
        ALLOWED
      )
    ).toBe(null);
    expect(
      readDesktopHandoffRequest(`${base}?scheme=exampleapp`, ALLOWED)
    ).toBe(null);
  });
});

describe('callback URL', () => {
  it('builds <scheme>://auth/handoff?code=... and reads it back', () => {
    const url = desktopHandoffCallbackUrl('exampleapp', 'abc_DEF-123', ALLOWED);
    expect(url).toBe('exampleapp://auth/handoff?code=abc_DEF-123');
    expect(readDesktopHandoffCallback(url, ALLOWED)).toEqual({
      scheme: 'exampleapp',
      code: 'abc_DEF-123',
    });
  });

  it('refuses to build for a web scheme or one off the allowlist', () => {
    expect(() => desktopHandoffCallbackUrl('https', 'c', ['https'])).toThrow();
    expect(() => desktopHandoffCallbackUrl('otherapp', 'c', ALLOWED)).toThrow();
  });

  it('reads null for the wrong scheme, host, path or code', () => {
    expect(
      readDesktopHandoffCallback('otherapp://auth/handoff?code=abc', ALLOWED)
    ).toBe(null);
    expect(
      readDesktopHandoffCallback('exampleapp://evil/handoff?code=abc', ALLOWED)
    ).toBe(null);
    expect(
      readDesktopHandoffCallback('exampleapp://auth/other?code=abc', ALLOWED)
    ).toBe(null);
    expect(
      readDesktopHandoffCallback('exampleapp://auth/handoff', ALLOWED)
    ).toBe(null);
    expect(
      readDesktopHandoffCallback(
        'exampleapp://auth/handoff?code=a%20b',
        ALLOWED
      )
    ).toBe(null);
    expect(readDesktopHandoffCallback('not a url', ALLOWED)).toBe(null);
  });
});

describe('AuthClient.mintDesktopHandoff', () => {
  const loginRoute = {
    '/api/auth/login': () =>
      jsonResponse({ access_token: 'browser-token', expires_in: 900 }),
  };

  it('posts the challenge with S256 and the bearer, and builds the callback URL', async () => {
    const fetchMock = routedFetch({
      ...loginRoute,
      '/api/auth/desktop-handoff': () =>
        jsonResponse({ code: 'minted-code', expires_in: 60 }),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.mintDesktopHandoff({
      codeChallenge: CHALLENGE,
      scheme: 'ExampleApp://',
    });

    expect(outcome).toEqual({
      ok: true,
      code: 'minted-code',
      expiresIn: 60,
      callbackUrl: 'exampleapp://auth/handoff?code=minted-code',
    });
    expect(bodyOf(fetchMock, '/api/auth/desktop-handoff')).toEqual({
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      scheme: 'exampleapp',
    });
    const headers = new Headers(
      callTo(fetchMock, '/api/auth/desktop-handoff').headers
    );
    expect(headers.get('authorization')).toBe('Bearer browser-token');
  });

  it('refuses a scheme off the allowlist without a request', async () => {
    const fetchMock = routedFetch(loginRoute);
    const auth = await signedIn(fetchMock);

    const outcome = await auth.mintDesktopHandoff({
      codeChallenge: CHALLENGE,
      scheme: 'otherapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'scheme-not-allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed challenge without a request', async () => {
    const fetchMock = routedFetch(loginRoute);
    const auth = await signedIn(fetchMock);

    const outcome = await auth.mintDesktopHandoff({
      codeChallenge: 'plain',
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers not-authenticated with no session, without a request', async () => {
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock);

    const outcome = await auth.mintDesktopHandoff({
      codeChallenge: CHALLENGE,
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'not-authenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'HANDOFF_SCHEME_NOT_ALLOWED', 'scheme-not-allowed'],
    [400, 'HANDOFF_INVALID_REQUEST', 'invalid-request'],
    [401, 'NOT_AUTHENTICATED', 'not-authenticated'],
    [404, undefined, 'unavailable'],
    [429, 'RATE_LIMITED', 'rate-limited'],
  ])('maps a %i %s to %s', async (status, code, reason) => {
    const fetchMock = routedFetch({
      ...loginRoute,
      '/api/auth/desktop-handoff': () => envelope(status, code),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.mintDesktopHandoff({
      codeChallenge: CHALLENGE,
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason });
    expect(auth.getState().status).toBe('authenticated');
  });

  it('rethrows a server error it does not model', async () => {
    const fetchMock = routedFetch({
      ...loginRoute,
      '/api/auth/desktop-handoff': () => envelope(500, undefined),
    });
    const auth = await signedIn(fetchMock);

    await expect(
      auth.mintDesktopHandoff({
        codeChallenge: CHALLENGE,
        scheme: 'exampleapp',
      })
    ).rejects.toThrow();
  });
});

describe('AuthClient.handOffToDesktop', () => {
  it('reads the launch URL and mints', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'browser-token', expires_in: 900 }),
      '/api/auth/desktop-handoff': () =>
        jsonResponse({ code: 'minted-code', expires_in: 60 }),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.handOffToDesktop({
      url: `${ORIGIN}/desktop-handoff?code_challenge=${CHALLENGE}&scheme=exampleapp-staging`,
    });

    expect(outcome).toMatchObject({
      ok: true,
      callbackUrl: 'exampleapp-staging://auth/handoff?code=minted-code',
    });
  });

  it('refuses a launch URL naming an unknown scheme', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login': () =>
        jsonResponse({ access_token: 'browser-token', expires_in: 900 }),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.handOffToDesktop({
      url: `${ORIGIN}/desktop-handoff?code_challenge=${CHALLENGE}&scheme=https`,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AuthClient.exchangeDesktopHandoff', () => {
  it('posts the code, verifier and scheme and adopts the session', async () => {
    const fetchMock = routedFetch({
      '/api/auth/desktop-handoff/exchange': () =>
        jsonResponse({
          access_token: 'desktop-token',
          token_type: 'bearer',
          expires_in: 900,
          user: { id: 'u1' },
        }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.exchangeDesktopHandoff({
      code: 'minted-code',
      codeVerifier: VERIFIER,
      scheme: 'exampleapp',
    });

    expect(outcome).toEqual({ ok: true, user: { id: 'u1' }, expiresIn: 900 });
    expect(auth.getAccessToken()).toBe('desktop-token');
    expect(auth.getState().status).toBe('authenticated');
    expect(bodyOf(fetchMock, '/api/auth/desktop-handoff/exchange')).toEqual({
      code: 'minted-code',
      code_verifier: VERIFIER,
      scheme: 'exampleapp',
    });
    expect(
      callTo(fetchMock, '/api/auth/desktop-handoff/exchange').credentials
    ).toBe('include');
  });

  it('refuses a scheme off the allowlist without a request', async () => {
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock);

    const outcome = await auth.exchangeDesktopHandoff({
      code: 'minted-code',
      codeVerifier: VERIFIER,
      scheme: 'otherapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'scheme-not-allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses every scheme when no allowlist is configured', async () => {
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock, []);

    const outcome = await auth.exchangeDesktopHandoff({
      code: 'minted-code',
      codeVerifier: VERIFIER,
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'scheme-not-allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed verifier without a request', async () => {
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock);

    const outcome = await auth.exchangeDesktopHandoff({
      code: 'minted-code',
      codeVerifier: 'too-short',
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'HANDOFF_INVALID', 'invalid'],
    [403, 'CROSS_SITE_REQUEST', 'refused'],
    [403, 'ACCOUNT_DISABLED', 'refused'],
    [404, undefined, 'unavailable'],
    [429, 'RATE_LIMITED', 'rate-limited'],
  ])('maps a %i %s to %s and stays anonymous', async (status, code, reason) => {
    const fetchMock = routedFetch({
      '/api/auth/desktop-handoff/exchange': () => envelope(status, code),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.exchangeDesktopHandoff({
      code: 'spent-code',
      codeVerifier: VERIFIER,
      scheme: 'exampleapp',
    });

    expect(outcome).toMatchObject({ ok: false, reason });
    expect(auth.getAccessToken()).toBe(null);
    expect(auth.getState().status).toBe('anonymous');
  });
});

describe('AuthClient.completeDesktopHandoff', () => {
  it('reads the callback URL and exchanges', async () => {
    const fetchMock = routedFetch({
      '/api/auth/desktop-handoff/exchange': () =>
        jsonResponse({ access_token: 'desktop-token', expires_in: 900 }),
    });
    const auth = authWith(fetchMock);

    const outcome = await auth.completeDesktopHandoff({
      url: 'exampleapp-staging://auth/handoff?code=minted-code',
      codeVerifier: VERIFIER,
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(bodyOf(fetchMock, '/api/auth/desktop-handoff/exchange')).toEqual({
      code: 'minted-code',
      code_verifier: VERIFIER,
      scheme: 'exampleapp-staging',
    });
  });

  it('refuses a callback on an unknown scheme without a request', async () => {
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock);

    const outcome = await auth.completeDesktopHandoff({
      url: 'otherapp://auth/handoff?code=minted-code',
      codeVerifier: VERIFIER,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
