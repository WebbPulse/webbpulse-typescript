import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import {
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
  classifyOAuthError,
  describeOAuthCallbackError,
  parseOAuthLinks,
  readOAuthCallback,
  stripOAuthParams,
} from './oauth.js';

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
  message = 'That provider is not linked.',
  init: { details?: Record<string, unknown>; retryAfter?: string } = {}
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      status,
      message,
      request_id: 'req_test',
      ...(code === undefined ? {} : { error_code: code }),
      ...(init.details === undefined ? {} : { details: init.details }),
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        ...(init.retryAfter === undefined
          ? {}
          : { 'retry-after': init.retryAfter }),
      },
    }
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

function authWith(
  fetchMock: ReturnType<typeof vi.fn>,
  navigate?: (url: string) => void
): AuthClient {
  return createAuthClient({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    clientOptions: { fetch: fetchMock, retries: 0 },
    ...(navigate === undefined ? {} : { navigate }),
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

function urlOf(fetchMock: ReturnType<typeof vi.fn>, suffix: string): string {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(suffix));
  if (call === undefined) {
    throw new Error(`${suffix} was never called`);
  }
  return String(call[0]);
}

function headerOf(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string,
  name: string
): string | null {
  return new Headers(callTo(fetchMock, suffix).headers).get(name);
}

const LOGIN_TOKENS = {
  access_token: 'access-1',
  token_type: 'Bearer',
  expires_in: 600,
};

/** The exact body of `GET /api/auth/oauth/links`, from the M6 route tests. */
const LINKS_BODY = {
  links: [
    {
      provider: 'google',
      email: 'user@example.test',
      email_verified: true,
      linked_at: '2026-09-01T10:00:00Z',
      last_login_at: '2026-09-09T18:30:00Z',
    },
    {
      provider: 'github',
      email: 'user@users.noreply.github.test',
      email_verified: false,
      linked_at: '2026-09-05T12:00:00Z',
      last_login_at: '',
    },
  ],
};

/** Signs a client in so the three authorized OAuth routes have a bearer token. */
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

describe('oauthStartUrl', () => {
  /**
   * The load-bearing assertion for the whole start leg. The route answers 302
   * to the provider, and a cross-origin redirect cannot be followed by script,
   * so this must be a URL the browser navigates to and never something fetched.
   */
  it('builds the provider start URL against the API origin', () => {
    const auth = authWith(routedFetch({}));
    expect(auth.oauthStartUrl(GOOGLE_PROVIDER)).toBe(
      'https://api.example.test/api/auth/oauth/google/start'
    );
  });

  it('carries return_to, mode and redirect_uri when given', () => {
    const auth = authWith(routedFetch({}));
    const url = new URL(
      auth.oauthStartUrl(GITHUB_PROVIDER, {
        returnTo: '/settings/security',
        mode: 'link',
        redirectUri: 'https://api.example.test/oauth/callback',
      })
    );
    expect(url.pathname).toBe('/api/auth/oauth/github/start');
    expect(url.searchParams.get('return_to')).toBe('/settings/security');
    expect(url.searchParams.get('mode')).toBe('link');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/oauth/callback'
    );
  });

  it('sends no query parameters at all when none were given', () => {
    // An empty `?` is not the same request: the server reads `mode` with a
    // default, and sending `mode=` would be a mode nobody asked for.
    const auth = authWith(routedFetch({}));
    expect(auth.oauthStartUrl(GOOGLE_PROVIDER)).not.toContain('?');
  });

  it('encodes the provider into the path', () => {
    const auth = authWith(routedFetch({}));
    expect(auth.oauthStartUrl('a/b')).toContain('/oauth/a%2Fb/start');
  });

  it('makes no request', () => {
    const fetchMock = routedFetch({});
    authWith(fetchMock).oauthStartUrl(GOOGLE_PROVIDER);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startOAuth', () => {
  it('navigates to the URL the builder produced', () => {
    const navigate = vi.fn();
    const fetchMock = routedFetch({});
    const auth = authWith(fetchMock, navigate);

    auth.startOAuth(GOOGLE_PROVIDER, { returnTo: '/dashboard' });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[0]).toBe(
      auth.oauthStartUrl(GOOGLE_PROVIDER, { returnTo: '/dashboard' })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('linkOAuthProvider', () => {
  it('posts to the link route and returns the authorization URL', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/github/link': () =>
        jsonResponse({
          authorization_url:
            'https://github.test/login/oauth/authorize?client_id=abc&state=s',
        }),
    });

    const outcome = await auth.linkOAuthProvider(GITHUB_PROVIDER, {
      returnTo: '/settings/security',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected a started link');
    }
    expect(outcome.authorizationUrl).toBe(
      'https://github.test/login/oauth/authorize?client_id=abc&state=s'
    );
    expect(callTo(fetchMock, '/github/link').method).toBe('POST');
    expect(
      JSON.parse(callTo(fetchMock, '/github/link').body as string)
    ).toEqual({ return_to: '/settings/security' });
  });

  /**
   * The reason this route exists at all rather than reusing the start route:
   * it is called over `fetch` with an `Authorization` header, and a redirect
   * would be followed by `fetch` without that header.
   */
  it('carries the bearer token', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        jsonResponse({ authorization_url: 'https://accounts.google.test/x' }),
    });

    await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(headerOf(fetchMock, '/google/link', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  it('sends an empty body when no options were given', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        jsonResponse({ authorization_url: 'https://accounts.google.test/x' }),
    });

    await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(
      JSON.parse(callTo(fetchMock, '/google/link').body as string)
    ).toEqual({});
  });

  it('never retries, because a start writes a state row', async () => {
    const calls: number[] = [];
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': (call) => {
        calls.push(call);
        return envelope(429, undefined, 'Too many attempts.');
      },
    });

    await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(calls).toEqual([0]);
  });

  it('returns already-linked for OAUTH_ALREADY_LINKED', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(
          409,
          'OAUTH_ALREADY_LINKED',
          'That Google account is already linked.'
        ),
    });

    const outcome = await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('already-linked');
    expect(outcome.code).toBe('OAUTH_ALREADY_LINKED');
    expect(outcome.message).toBe('That Google account is already linked.');
  });

  it('returns provider-unavailable for an unknown provider', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/gitlab/link': () =>
        envelope(400, 'OAUTH_PROVIDER_UNKNOWN', 'Unknown provider.'),
    });

    const outcome = await auth.linkOAuthProvider('gitlab');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('provider-unavailable');
  });

  it('folds an unconfigured provider into the same case', async () => {
    // A user can do nothing about either, and a settings page renders one
    // "not available" state for both.
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(503, 'OAUTH_PROVIDER_UNAVAILABLE', 'Not configured.'),
    });

    const outcome = await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('provider-unavailable');
  });

  it('reads Retry-After off the header on a rate limit', async () => {
    // The rate limit dependency raises a bare 429 with no error_code and puts
    // the wait in the header, which `@webbpulse/api-client` now keeps.
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(429, undefined, 'Too many attempts.', { retryAfter: '900' }),
    });

    const outcome = await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== 'rate-limited') {
      throw new Error('expected a rate limit');
    }
    expect(outcome.retryAfter).toBe(900);
  });

  it('falls back to a retry_after in the envelope details', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(429, undefined, 'Too many attempts.', {
          details: { retry_after: 120 },
        }),
    });

    const outcome = await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    if (outcome.ok || outcome.reason !== 'rate-limited') {
      throw new Error('expected a rate limit');
    }
    expect(outcome.retryAfter).toBe(120);
  });

  it('leaves retryAfter undefined when the server sent no hint', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(429, undefined, 'Too many attempts.'),
    });

    const outcome = await auth.linkOAuthProvider(GOOGLE_PROVIDER);

    if (outcome.ok || outcome.reason !== 'rate-limited') {
      throw new Error('expected a rate limit');
    }
    expect(outcome.retryAfter).toBeUndefined();
  });

  /**
   * A 401 the transport could not repair is the session ending, not a settings
   * page error state. Turning it into an outcome would hide it.
   */
  it('throws a 401 rather than modelling it', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(401, 'NOT_AUTHENTICATED', 'Sign in to link a provider.'),
      '/api/auth/refresh': () => envelope(401, 'SESSION_REVOKED', 'Gone.'),
    });

    await expect(auth.linkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });

  it('throws a 500', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(500, 'INTERNAL_ERROR', 'Something went wrong.'),
    });

    await expect(auth.linkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });
});

describe('listOAuthLinks', () => {
  it('reads the links and camel cases the fields', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/links': () => jsonResponse(LINKS_BODY),
    });

    const outcome = await auth.listOAuthLinks();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected the list');
    }
    expect(outcome.links).toEqual([
      {
        provider: 'google',
        email: 'user@example.test',
        emailVerified: true,
        linkedAt: '2026-09-01T10:00:00Z',
        lastLoginAt: '2026-09-09T18:30:00Z',
      },
      {
        provider: 'github',
        email: 'user@users.noreply.github.test',
        emailVerified: false,
        linkedAt: '2026-09-05T12:00:00Z',
        lastLoginAt: undefined,
      },
    ]);
    expect(callTo(fetchMock, '/oauth/links').method).toBe('GET');
    expect(headerOf(fetchMock, '/oauth/links', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  it('reads an empty list', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/links': () => jsonResponse({ links: [] }),
    });

    const outcome = await auth.listOAuthLinks();

    if (!outcome.ok) {
      throw new Error('expected the list');
    }
    expect(outcome.links).toEqual([]);
  });

  it('goes to the list route, which has no provider segment', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/links': () => jsonResponse(LINKS_BODY),
    });

    await auth.listOAuthLinks();

    expect(urlOf(fetchMock, '/oauth/links')).toBe(
      'https://api.example.test/api/auth/oauth/links'
    );
  });

  it('throws a 401 rather than modelling it', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/links': () =>
        envelope(401, 'NOT_AUTHENTICATED', 'Sign in to see your providers.'),
      '/api/auth/refresh': () => envelope(401, 'SESSION_REVOKED', 'Gone.'),
    });

    await expect(auth.listOAuthLinks()).rejects.toThrow();
  });
});

describe('unlinkOAuthProvider', () => {
  it('deletes the link', async () => {
    const { auth, fetchMock } = await signedIn({
      '/api/auth/oauth/google/link': () => jsonResponse({ unlinked: true }),
    });

    const outcome = await auth.unlinkOAuthProvider(GOOGLE_PROVIDER);

    expect(outcome.ok).toBe(true);
    expect(callTo(fetchMock, '/google/link').method).toBe('DELETE');
    expect(headerOf(fetchMock, '/google/link', 'authorization')).toBe(
      'Bearer access-1'
    );
  });

  /**
   * The refusal that matters. Removing the last sign-in method locks a user out
   * of their own account permanently, and the remedy is a specific instruction
   * ("set a password first") that no generic error handler would know to give,
   * which is why this is a named outcome rather than a thrown 409.
   */
  it('returns last-sign-in-method with the server sentence', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(
          409,
          'OAUTH_LAST_SIGN_IN_METHOD',
          'Set a password before removing your last sign-in method.'
        ),
    });

    const outcome = await auth.unlinkOAuthProvider(GOOGLE_PROVIDER);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('last-sign-in-method');
    expect(outcome.code).toBe('OAUTH_LAST_SIGN_IN_METHOD');
    expect(outcome.message).toBe(
      'Set a password before removing your last sign-in method.'
    );
  });

  it('returns not-linked for a provider that is not attached', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/github/link': () =>
        envelope(404, 'OAUTH_NOT_LINKED', 'That provider is not linked.'),
    });

    const outcome = await auth.unlinkOAuthProvider(GITHUB_PROVIDER);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.reason).toBe('not-linked');
  });

  it('never retries', async () => {
    const calls: number[] = [];
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': (call) => {
        calls.push(call);
        return envelope(503, 'OAUTH_PROVIDER_UNAVAILABLE', 'Not configured.');
      },
    });

    await auth.unlinkOAuthProvider(GOOGLE_PROVIDER);

    expect(calls).toEqual([0]);
  });

  it('throws a 500', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(500, 'INTERNAL_ERROR', 'Something went wrong.'),
    });

    await expect(auth.unlinkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });
});

describe('the refusal sets are per route', () => {
  /**
   * `already-linked` is a legitimate outcome on the attach and a server bug on
   * the detach. An explicit set per route is what stops one becoming a silent
   * success on the other.
   */
  it('throws an already-linked arriving from the unlink route', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': (call) =>
        call === 0
          ? envelope(409, 'OAUTH_ALREADY_LINKED', 'Already linked.')
          : jsonResponse({}),
    });

    await expect(auth.unlinkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });

  it('throws a last-sign-in-method arriving from the link route', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(409, 'OAUTH_LAST_SIGN_IN_METHOD', 'Last method.'),
    });

    await expect(auth.linkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });

  it('throws a 429 arriving from the unlink route, which models none', async () => {
    // The start limit is on the start route. A 429 on a delete is not something
    // the standard puts there, so it is a surprise worth throwing on.
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () => envelope(429, undefined, 'Slow.'),
    });

    await expect(auth.unlinkOAuthProvider(GOOGLE_PROVIDER)).rejects.toThrow();
  });
});

describe('the client state after a refusal', () => {
  it('stays authenticated, because a refusal is not a session ending', async () => {
    const { auth } = await signedIn({
      '/api/auth/oauth/google/link': () =>
        envelope(409, 'OAUTH_LAST_SIGN_IN_METHOD', 'Last method.'),
    });

    await auth.unlinkOAuthProvider(GOOGLE_PROVIDER);

    expect(auth.getState().status).toBe('authenticated');
    expect(auth.getState().hasAccessToken).toBe(true);
    // A modelled refusal is handed back, not parked for a page level boundary.
    expect(auth.getState().error).toBeNull();
  });
});

describe('readOAuthCallback', () => {
  it('reads a completed sign-in', () => {
    expect(readOAuthCallback('https://app.test/dashboard?oauth=1')).toEqual({
      kind: 'signed-in',
    });
  });

  it('reads an MFA challenge and its ticket', () => {
    expect(
      readOAuthCallback('https://app.test/login?mfa_ticket=tkt-1')
    ).toEqual({ kind: 'mfa-required', ticket: 'tkt-1' });
  });

  it('reads a completed link', () => {
    expect(
      readOAuthCallback('https://app.test/settings/security?oauth_linked=1')
    ).toEqual({ kind: 'linked' });
  });

  it('reads a refusal and narrows the code', () => {
    expect(
      readOAuthCallback('https://app.test/login?oauth_error=OAUTH_CANCELLED')
    ).toEqual({
      kind: 'error',
      code: 'OAUTH_CANCELLED',
      rawCode: 'OAUTH_CANCELLED',
    });
  });

  it('keeps the raw code when this version does not name it', () => {
    const result = readOAuthCallback(
      'https://app.test/login?oauth_error=OAUTH_SOMETHING_NEW'
    );
    expect(result).toEqual({
      kind: 'error',
      code: undefined,
      rawCode: 'OAUTH_SOMETHING_NEW',
    });
  });

  it('parses a relative href', () => {
    expect(readOAuthCallback('/dashboard?oauth=1')).toEqual({
      kind: 'signed-in',
    });
  });

  it('returns null for a page not reached from a callback', () => {
    expect(readOAuthCallback('https://app.test/dashboard')).toBeNull();
    expect(
      readOAuthCallback('https://app.test/dashboard?tab=profile')
    ).toBeNull();
  });

  it('returns null for an absent or unparseable href', () => {
    expect(readOAuthCallback(null)).toBeNull();
    expect(readOAuthCallback(undefined)).toBeNull();
    expect(readOAuthCallback('')).toBeNull();
  });

  /**
   * A `return_to` that already carried its own `?oauth=1` must not let a stale
   * parameter outrank a live refusal. Reporting a failed sign-in as a
   * successful one is the wrong way round to be wrong.
   */
  it('puts an error ahead of every other parameter', () => {
    const result = readOAuthCallback(
      'https://app.test/x?oauth=1&oauth_linked=1&mfa_ticket=t&oauth_error=OAUTH_CANCELLED'
    );
    expect(result?.kind).toBe('error');
  });

  it('puts an MFA ticket ahead of a success flag', () => {
    const result = readOAuthCallback('https://app.test/x?oauth=1&mfa_ticket=t');
    expect(result).toEqual({ kind: 'mfa-required', ticket: 't' });
  });

  it('ignores an empty error or ticket value', () => {
    expect(
      readOAuthCallback('https://app.test/x?oauth_error=&oauth=1')
    ).toEqual({ kind: 'signed-in' });
    expect(readOAuthCallback('https://app.test/x?mfa_ticket=&oauth=1')).toEqual(
      { kind: 'signed-in' }
    );
  });
});

describe('stripOAuthParams', () => {
  /**
   * The sharp reason: an MFA ticket is a live bearer value, and leaving it in
   * the address bar leaves it in the browser history and in the `Referer` of
   * the next navigation off the page.
   */
  it('removes every callback parameter', () => {
    expect(
      stripOAuthParams(
        'https://app.test/x?oauth=1&oauth_linked=1&mfa_ticket=t&oauth_error=E'
      )
    ).toBe('https://app.test/x');
  });

  it('leaves the application parameters alone', () => {
    expect(stripOAuthParams('https://app.test/x?tab=security&oauth=1')).toBe(
      'https://app.test/x?tab=security'
    );
  });

  it('keeps a relative href relative', () => {
    // The output feeds `history.replaceState`, which must not move the page to
    // the parsing base origin.
    expect(stripOAuthParams('/settings?oauth_linked=1&tab=security')).toBe(
      '/settings?tab=security'
    );
  });

  it('keeps the hash', () => {
    expect(stripOAuthParams('https://app.test/x?oauth=1#section')).toBe(
      'https://app.test/x#section'
    );
  });

  it('returns a URL with nothing to strip unchanged in meaning', () => {
    expect(stripOAuthParams('https://app.test/x?tab=a')).toBe(
      'https://app.test/x?tab=a'
    );
  });
});

describe('describeOAuthCallbackError', () => {
  it('does not render a cancellation as an error', () => {
    expect(
      describeOAuthCallbackError({
        kind: 'error',
        code: 'OAUTH_CANCELLED',
        rawCode: 'OAUTH_CANCELLED',
      })
    ).toBe('Sign-in was cancelled.');
  });

  it('names the remedy for an unverified email', () => {
    const message = describeOAuthCallbackError({
      kind: 'error',
      code: 'OAUTH_EMAIL_UNVERIFIED',
      rawCode: 'OAUTH_EMAIL_UNVERIFIED',
    });
    expect(message).toContain('password');
    expect(message).toContain('link');
  });

  it('falls back for a code it does not know', () => {
    expect(
      describeOAuthCallbackError(
        { kind: 'error', code: undefined, rawCode: 'OAUTH_WHATEVER' },
        'Could not sign in.'
      )
    ).toBe('Could not sign in.');
  });
});

describe('parseOAuthLinks', () => {
  it('skips an entry with no provider', () => {
    // The list crosses a repository boundary with nothing enforcing the shape
    // at build time, so a malformed entry is dropped rather than rendered.
    expect(
      parseOAuthLinks({
        links: [{ email: 'a@b.test' }, { provider: 'google' }],
      })
    ).toEqual([
      {
        provider: 'google',
        email: '',
        emailVerified: false,
        linkedAt: '',
        lastLoginAt: undefined,
      },
    ]);
  });

  it('returns an empty array for a body that is not the list shape', () => {
    expect(parseOAuthLinks(null)).toEqual([]);
    expect(parseOAuthLinks('nope')).toEqual([]);
    expect(parseOAuthLinks({})).toEqual([]);
    expect(parseOAuthLinks({ links: 'nope' })).toEqual([]);
  });

  it('treats anything but true as unverified', () => {
    const links = parseOAuthLinks({
      links: [{ provider: 'github', email_verified: 'true' }],
    });
    expect(links[0]?.emailVerified).toBe(false);
  });
});

describe('classifyOAuthError', () => {
  it('returns null for anything that is not an ApiError', () => {
    expect(
      classifyOAuthError(new Error('offline'), new Set(['not-linked'] as const))
    ).toBeNull();
  });
});
