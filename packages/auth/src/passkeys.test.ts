import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import { AuthSessionEndedError } from './errors.js';
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  classifyPasskeyError,
  conditionalMediationAvailable,
  credentialToJSON,
  isPasskeyCancellation,
  parsePasskey,
  parsePasskeyChallenge,
  parsePasskeys,
  passkeysSupported,
  toCreationOptions,
  toRequestOptions,
} from './passkeys.js';

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
  message = 'That passkey could not be verified.',
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
    const seen = (counts.get(key) ?? 0) + 1;
    counts.set(key, seen);
    const result = routes[key]!(seen, init);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
}

function authWith(
  fetchMock: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof createAuthClient<User>>[0]> = {}
): AuthClient<User> {
  return createAuthClient<User>({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    clientOptions: { fetch: fetchMock, retries: 0 },
    ...options,
  });
}

/** A stub authenticator returning a plain JSON credential. */
function stubWebAuthn(
  overrides: {
    create?: (options: unknown) => Promise<unknown>;
    get?: (options: unknown) => Promise<unknown>;
  } = {}
): { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(
      overrides.create ??
        (() => Promise.resolve({ id: 'cred_1', type: 'public-key' }))
    ),
    get: vi.fn(
      overrides.get ??
        (() => Promise.resolve({ id: 'cred_1', type: 'public-key' }))
    ),
  };
}

/** The seven routes, wired to sensible defaults a test can override. */
function passkeyRoutes(overrides: {
  [suffix: string]: (call: number, init: RequestInit) => Response | Error;
}): ReturnType<typeof vi.fn> {
  return routedFetch({
    '/api/auth/login': () =>
      jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    ...overrides,
  });
}

/** A client already holding an access token, for the authorized routes. */
async function signedIn(
  fetchMock: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof createAuthClient<User>>[0]> = {}
): Promise<AuthClient<User>> {
  const auth = authWith(fetchMock, options);
  await auth.login({ email: ALICE.email, password: 'pw' });
  return auth;
}

const SUMMARY = {
  credential_id: 'cred_1',
  name: 'Laptop',
  created_at: '2026-09-01T00:00:00Z',
  last_used_at: '2026-09-05T00:00:00Z',
  transports: ['internal', 'hybrid'],
  aaguid: 'aa-guid',
  backup_eligible: true,
  backup_state: true,
  user_verified: true,
};

afterEach(() => {
  delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  vi.restoreAllMocks();
});

describe('passkeysSupported', () => {
  it('is false with no PublicKeyCredential on the global', () => {
    expect(passkeysSupported()).toBe(false);
  });

  it('is true when the constructor is present', () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
      function () {};
    expect(passkeysSupported()).toBe(true);
  });
});

describe('conditionalMediationAvailable', () => {
  it('is false with no WebAuthn at all', async () => {
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it('is false when the browser has WebAuthn but not the check', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {};
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it('reports what the browser says', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isConditionalMediationAvailable: () => Promise.resolve(true),
    };
    await expect(conditionalMediationAvailable()).resolves.toBe(true);
  });

  it('is false rather than rejecting when the check throws', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isConditionalMediationAvailable: () => Promise.reject(new Error('nope')),
    };
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });
});

describe('isPasskeyCancellation', () => {
  it('recognises a dismissed prompt', () => {
    expect(isPasskeyCancellation({ name: 'NotAllowedError' })).toBe(true);
  });

  it('recognises an aborted ceremony', () => {
    expect(isPasskeyCancellation({ name: 'AbortError' })).toBe(true);
  });

  it('does not claim an ordinary error', () => {
    expect(isPasskeyCancellation(new Error('boom'))).toBe(false);
    expect(isPasskeyCancellation(null)).toBe(false);
    expect(isPasskeyCancellation('NotAllowedError')).toBe(false);
  });
});

describe('base64url conversion', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = bufferToBase64Url(bytes);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(new Uint8Array(base64UrlToBuffer(encoded))).toEqual(bytes);
  });

  it('decodes an unpadded value the server sent', () => {
    // "chal" base64url-encodes to "Y2hhbA" with the padding stripped.
    expect(new Uint8Array(base64UrlToBuffer('Y2hhbA'))).toEqual(
      new Uint8Array([99, 104, 97, 108])
    );
  });
});

describe('toCreationOptions', () => {
  it('decodes the challenge, the user id and every excluded credential', () => {
    const options = toCreationOptions({
      challenge: 'Y2hhbA',
      rp: { id: 'example.test', name: 'Example' },
      user: { id: 'dTE', name: 'alice', displayName: 'Alice' },
      excludeCredentials: [{ id: 'Y3Iy', type: 'public-key' }],
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    });

    expect(options['challenge']).toBeInstanceOf(ArrayBuffer);
    expect((options['user'] as { id: unknown }).id).toBeInstanceOf(ArrayBuffer);
    expect(
      (options['excludeCredentials'] as { id: unknown }[])[0]?.id
    ).toBeInstanceOf(ArrayBuffer);
    // Untouched, so an option this version has never heard of still arrives.
    expect(options['rp']).toEqual({ id: 'example.test', name: 'Example' });
    expect(options['pubKeyCredParams']).toEqual([
      { alg: -7, type: 'public-key' },
    ]);
  });

  it('tolerates a document with no user and no exclude list', () => {
    const options = toCreationOptions({ challenge: 'Y2hhbA' });
    expect(options['challenge']).toBeInstanceOf(ArrayBuffer);
    expect(options['user']).toBeUndefined();
  });
});

describe('toRequestOptions', () => {
  it('decodes the challenge and every allowed credential', () => {
    const options = toRequestOptions({
      challenge: 'Y2hhbA',
      rpId: 'example.test',
      allowCredentials: [{ id: 'Y3Iy', type: 'public-key' }],
      userVerification: 'preferred',
    });

    expect(options['challenge']).toBeInstanceOf(ArrayBuffer);
    expect(
      (options['allowCredentials'] as { id: unknown }[])[0]?.id
    ).toBeInstanceOf(ArrayBuffer);
    expect(options['userVerification']).toBe('preferred');
  });

  it('leaves a discoverable request with no allowCredentials alone', () => {
    const options = toRequestOptions({ challenge: 'Y2hhbA' });
    expect(options['allowCredentials']).toBeUndefined();
  });
});

describe('credentialToJSON', () => {
  it('prefers the browser its own toJSON', () => {
    const credential = {
      rawId: new Uint8Array([1, 2]).buffer,
      toJSON: () => ({ id: 'from-browser' }),
    };
    expect(credentialToJSON(credential)).toEqual({ id: 'from-browser' });
  });

  it('serialises a registration response by hand', () => {
    const json = credentialToJSON({
      id: 'cred_1',
      rawId: new Uint8Array([99, 114]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        attestationObject: new Uint8Array([2]).buffer,
        getTransports: () => ['internal'],
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    });

    expect(json['id']).toBe('cred_1');
    expect(json['type']).toBe('public-key');
    expect(json['authenticatorAttachment']).toBe('platform');
    expect(json['clientExtensionResults']).toEqual({
      credProps: { rk: true },
    });
    const response = json['response'] as Record<string, unknown>;
    expect(typeof response['attestationObject']).toBe('string');
    expect(response['transports']).toEqual(['internal']);
    // An assertion field must not appear on a registration document.
    expect(response['signature']).toBeUndefined();
  });

  it('serialises an authentication response by hand', () => {
    const json = credentialToJSON({
      id: 'cred_1',
      rawId: new Uint8Array([99]).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: new Uint8Array([4]).buffer,
      },
      getClientExtensionResults: () => ({}),
    });

    const response = json['response'] as Record<string, unknown>;
    expect(typeof response['signature']).toBe('string');
    expect(typeof response['authenticatorData']).toBe('string');
    expect(typeof response['userHandle']).toBe('string');
    expect(response['attestationObject']).toBeUndefined();
  });

  it('sends a null userHandle as null rather than an empty string', () => {
    const json = credentialToJSON({
      id: 'cred_1',
      rawId: new Uint8Array([99]).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    });
    expect(
      (json['response'] as Record<string, unknown>)['userHandle']
    ).toBeNull();
  });

  it('passes a plain object through unchanged', () => {
    expect(credentialToJSON({ id: 'cred_1', type: 'public-key' })).toEqual({
      id: 'cred_1',
      type: 'public-key',
    });
  });

  it('is an empty document for a non-object', () => {
    expect(credentialToJSON(null)).toEqual({});
    expect(credentialToJSON('nope')).toEqual({});
  });
});

describe('parsePasskeyChallenge', () => {
  it('reads both halves of an options body', () => {
    expect(
      parsePasskeyChallenge({
        challenge_id: 'ch_1',
        publicKey: { challenge: 'Y2hhbA' },
      })
    ).toEqual({ challengeId: 'ch_1', publicKey: { challenge: 'Y2hhbA' } });
  });

  it('is empty for a body of the wrong shape', () => {
    expect(parsePasskeyChallenge(null)).toEqual({
      challengeId: '',
      publicKey: {},
    });
    expect(parsePasskeyChallenge({ publicKey: 'nope' })).toEqual({
      challengeId: '',
      publicKey: {},
    });
  });
});

describe('parsePasskey', () => {
  it('maps every field to camelCase', () => {
    expect(parsePasskey(SUMMARY)).toEqual({
      credentialId: 'cred_1',
      name: 'Laptop',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: '2026-09-05T00:00:00Z',
      transports: ['internal', 'hybrid'],
      aaguid: 'aa-guid',
      backupEligible: true,
      backupState: true,
      userVerified: true,
    });
  });

  it('reports a never-used passkey as undefined rather than an empty string', () => {
    const parsed = parsePasskey({ ...SUMMARY, last_used_at: '' });
    expect(parsed?.lastUsedAt).toBeUndefined();
  });

  it('defends each field against a body of the wrong shape', () => {
    const parsed = parsePasskey({
      credential_id: 'cred_1',
      name: 42,
      transports: ['usb', 7],
      backup_eligible: 'yes',
    });
    expect(parsed).toEqual({
      credentialId: 'cred_1',
      name: '',
      createdAt: '',
      lastUsedAt: undefined,
      transports: ['usb'],
      aaguid: '',
      backupEligible: false,
      backupState: false,
      userVerified: false,
    });
  });

  it('is null without a credential id', () => {
    expect(parsePasskey({ name: 'Laptop' })).toBeNull();
    expect(parsePasskey({ credential_id: '' })).toBeNull();
    expect(parsePasskey(null)).toBeNull();
  });
});

describe('parsePasskeys', () => {
  it('reads the array and drops entries with no credential id', () => {
    expect(
      parsePasskeys({ passkeys: [SUMMARY, { name: 'orphan' }, null] })
    ).toHaveLength(1);
  });

  it('is empty for a body of the wrong shape', () => {
    expect(parsePasskeys(null)).toEqual([]);
    expect(parsePasskeys({ passkeys: 'nope' })).toEqual([]);
  });
});

describe('classifyPasskeyError', () => {
  const ALL = new Set([
    'rejected',
    'already-registered',
    'last-credential',
    'not-found',
    'name-required',
    'unavailable',
    'rate-limited',
    'cancelled',
  ] as const);

  /**
   * The `ApiError` a route would throw, obtained by making a real call.
   *
   * `register` is the vehicle rather than one of the passkey methods, because
   * every passkey method classifies rather than throws and would hand back an
   * outcome instead of the error this suite is trying to inspect.
   */
  async function apiErrorFor(response: Response): Promise<unknown> {
    const auth = authWith(
      routedFetch({ '/api/auth/register': () => response })
    );
    return auth.register({}).then(
      () => new Error('expected the call to reject'),
      (error: unknown) => error
    );
  }

  it('is null for something that is not an ApiError', () => {
    expect(classifyPasskeyError(new Error('offline'), ALL)).toBeNull();
  });

  it('classifies a dismissed prompt without any envelope', () => {
    const refusal = classifyPasskeyError({ name: 'NotAllowedError' }, ALL);
    expect(refusal).toMatchObject({
      ok: false,
      reason: 'cancelled',
      code: undefined,
    });
  });

  it('does not classify a cancellation the caller does not model', () => {
    expect(
      classifyPasskeyError({ name: 'NotAllowedError' }, new Set(['rejected']))
    ).toBeNull();
  });

  it('folds the challenge and credential codes into one rejection', async () => {
    for (const code of [
      'PASSKEY_REJECTED',
      'PASSKEY_CHALLENGE_INVALID',
      'CREDENTIAL_REQUIRED',
    ]) {
      const error = await apiErrorFor(envelope(401, code));
      expect(classifyPasskeyError(error, ALL)).toMatchObject({
        reason: 'rejected',
      });
    }
  });

  it('folds both disabled codes into one unavailable outcome', async () => {
    for (const code of ['PASSKEYS_DISABLED', 'PASSKEY_LOGIN_DISABLED']) {
      const error = await apiErrorFor(envelope(403, code));
      expect(classifyPasskeyError(error, ALL)).toMatchObject({
        reason: 'unavailable',
      });
    }
  });

  it('names the remaining refusals individually', async () => {
    const cases: [string, string][] = [
      ['PASSKEY_ALREADY_REGISTERED', 'already-registered'],
      ['LAST_CREDENTIAL', 'last-credential'],
      ['PASSKEY_NOT_FOUND', 'not-found'],
      ['PASSKEY_NAME_REQUIRED', 'name-required'],
    ];
    for (const [code, reason] of cases) {
      const error = await apiErrorFor(envelope(409, code));
      expect(classifyPasskeyError(error, ALL)).toMatchObject({ reason });
    }
  });

  it('reads Retry-After off a bare 429', async () => {
    const error = await apiErrorFor(
      envelope(429, undefined, 'Slow down.', { retryAfter: '45' })
    );
    expect(classifyPasskeyError(error, ALL)).toMatchObject({
      reason: 'rate-limited',
      retryAfter: 45,
    });
  });

  it('falls back to a retry_after in the envelope details', async () => {
    const error = await apiErrorFor(
      envelope(429, undefined, 'Slow down.', { details: { retry_after: 30 } })
    );
    expect(classifyPasskeyError(error, ALL)).toMatchObject({
      retryAfter: 30,
    });
  });

  it('leaves retryAfter undefined when the server said nothing', async () => {
    const error = await apiErrorFor(envelope(429, undefined));
    expect(classifyPasskeyError(error, ALL)).toMatchObject({
      retryAfter: undefined,
    });
  });

  it('does not classify a refusal the caller does not model', async () => {
    const error = await apiErrorFor(envelope(409, 'LAST_CREDENTIAL'));
    expect(classifyPasskeyError(error, new Set(['not-found']))).toBeNull();
  });

  it('never classifies a session that ended', async () => {
    const error = await apiErrorFor(envelope(401, 'NOT_AUTHENTICATED'));
    expect(classifyPasskeyError(error, ALL)).toBeNull();
  });
});

describe('AuthClient.registerPasskey', () => {
  it('carries the challenge id from the options leg to the verify leg', async () => {
    const webAuthn = stubWebAuthn();
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/register/options': () =>
        jsonResponse({
          challenge_id: 'ch_1',
          publicKey: { challenge: 'Y2hhbA', user: { id: 'dTE' } },
        }),
      '/api/auth/passkeys/register/verify': () =>
        jsonResponse({ registered: true, passkey: SUMMARY }),
    });
    const auth = await signedIn(fetchMock, { webAuthn });

    const outcome = await auth.registerPasskey({ name: 'Laptop' });

    expect(outcome).toEqual({ ok: true, passkey: parsePasskey(SUMMARY) });
    const verify = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/register/verify')
    );
    expect(JSON.parse((verify?.[1] as RequestInit).body as string)).toEqual({
      challenge_id: 'ch_1',
      credential: { id: 'cred_1', type: 'public-key' },
      name: 'Laptop',
    });
  });

  it('hands the browser the decoded publicKey document and nothing else', async () => {
    const webAuthn = stubWebAuthn();
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          jsonResponse({
            challenge_id: 'ch_1',
            publicKey: { challenge: 'Y2hhbA' },
          }),
        '/api/auth/passkeys/register/verify': () =>
          jsonResponse({ registered: true, passkey: SUMMARY }),
      }),
      { webAuthn }
    );

    await auth.registerPasskey();

    const request = webAuthn.create.mock.calls[0]?.[0] as {
      publicKey: Record<string, unknown>;
    };
    // The challenge id is the server's handle on a row and must not leak into
    // the ceremony the browser runs.
    expect(request.publicKey['challenge']).toBeInstanceOf(ArrayBuffer);
    expect(request.publicKey['challenge_id']).toBeUndefined();
  });

  it('omits the name when none was given', async () => {
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/register/options': () =>
        jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      '/api/auth/passkeys/register/verify': () =>
        jsonResponse({ registered: true, passkey: SUMMARY }),
    });
    const auth = await signedIn(fetchMock, { webAuthn: stubWebAuthn() });

    await auth.registerPasskey();

    const verify = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/register/verify')
    );
    expect(
      JSON.parse((verify?.[1] as RequestInit).body as string)
    ).not.toHaveProperty('name');
  });

  it('rejects with no session rather than opening a prompt', async () => {
    const webAuthn = stubWebAuthn();
    const auth = authWith(routedFetch({}), { webAuthn });

    await expect(auth.registerPasskey()).rejects.toBeInstanceOf(
      AuthSessionEndedError
    );
    expect(webAuthn.create).not.toHaveBeenCalled();
  });

  it('reports an authenticator that is already enrolled', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
        '/api/auth/passkeys/register/verify': () =>
          envelope(
            409,
            'PASSKEY_ALREADY_REGISTERED',
            'That passkey is already registered.'
          ),
      }),
      { webAuthn: stubWebAuthn() }
    );

    expect(await auth.registerPasskey()).toEqual({
      ok: false,
      reason: 'already-registered',
      code: 'PASSKEY_ALREADY_REGISTERED',
      message: 'That passkey is already registered.',
    });
  });

  it('reports a dismissed prompt as cancelled rather than an error', async () => {
    const webAuthn = stubWebAuthn({
      create: () =>
        Promise.reject(
          Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })
        ),
    });
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      }),
      { webAuthn }
    );

    const outcome = await auth.registerPasskey();

    expect(outcome).toMatchObject({ ok: false, reason: 'cancelled' });
    // A cancelled ceremony is not an error state on the client.
    expect(auth.getState().error).toBeNull();
    expect(auth.getState().status).toBe('authenticated');
  });

  it('reports a deployment with passkeys switched off', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          envelope(503, 'PASSKEYS_DISABLED', 'Passkeys are not available.'),
      }),
      { webAuthn: stubWebAuthn() }
    );

    expect(await auth.registerPasskey()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      code: 'PASSKEYS_DISABLED',
    });
  });

  it('throws when the verify leg answers with no passkey', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
        '/api/auth/passkeys/register/verify': () =>
          jsonResponse({ registered: true }),
      }),
      { webAuthn: stubWebAuthn() }
    );

    await expect(auth.registerPasskey()).rejects.toThrow(/no passkey/);
  });

  it('does not retry either leg', async () => {
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/register/options': () =>
        jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      '/api/auth/passkeys/register/verify': () =>
        jsonResponse({ registered: true, passkey: SUMMARY }),
    });
    const auth = await signedIn(fetchMock, { webAuthn: stubWebAuthn() });

    await auth.registerPasskey();

    const optionsCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/register/options')
    );
    expect(optionsCalls).toHaveLength(1);
  });
});

describe('AuthClient.signInWithPasskey', () => {
  it('signs in discoverably with no email in the body', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login/passkey/options': () =>
        jsonResponse({
          challenge_id: 'ch_1',
          publicKey: { challenge: 'Y2hhbA', allowCredentials: [] },
        }),
      '/api/auth/login/passkey/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE }),
    });
    const auth = authWith(fetchMock, { webAuthn: stubWebAuthn() });

    const outcome = await auth.signInWithPasskey();

    expect(outcome).toEqual({
      ok: true,
      kind: 'signed-in',
      user: ALICE,
      expiresIn: 600,
    });
    expect(auth.getAccessToken()).toBe('a1');
    const options = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/passkey/options')
    );
    expect(JSON.parse((options?.[1] as RequestInit).body as string)).toEqual(
      {}
    );
  });

  it('sends the email when the form collected one', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login/passkey/options': () =>
        jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      '/api/auth/login/passkey/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, { webAuthn: stubWebAuthn() });

    await auth.signInWithPasskey({ email: ALICE.email });

    const options = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/passkey/options')
    );
    expect(JSON.parse((options?.[1] as RequestInit).body as string)).toEqual({
      email: ALICE.email,
    });
  });

  it('posts the challenge id and the serialised credential', async () => {
    const fetchMock = routedFetch({
      '/api/auth/login/passkey/options': () =>
        jsonResponse({ challenge_id: 'ch_9', publicKey: {} }),
      '/api/auth/login/passkey/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, { webAuthn: stubWebAuthn() });

    await auth.signInWithPasskey();

    const verify = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/passkey/verify')
    );
    expect(JSON.parse((verify?.[1] as RequestInit).body as string)).toEqual({
      challenge_id: 'ch_9',
      credential: { id: 'cred_1', type: 'public-key' },
    });
  });

  it('passes mediation and a signal through to the browser', async () => {
    const webAuthn = stubWebAuthn();
    const controller = new AbortController();
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
        '/api/auth/login/passkey/verify': () =>
          jsonResponse({ access_token: 'a1', expires_in: 600 }),
      }),
      { webAuthn }
    );

    await auth.signInWithPasskey({
      mediation: 'conditional',
      signal: controller.signal,
    });

    expect(webAuthn.get.mock.calls[0]?.[0]).toMatchObject({
      mediation: 'conditional',
      signal: controller.signal,
    });
  });

  it('reports an MFA challenge for a passkey with no user verification', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
        '/api/auth/login/passkey/verify': () =>
          jsonResponse({
            mfa_required: true,
            mfa_ticket: 'tkt',
            factors: ['totp'],
          }),
      }),
      { webAuthn: stubWebAuthn() }
    );

    const outcome = await auth.signInWithPasskey();

    expect(outcome).toEqual({
      ok: true,
      kind: 'mfa-required',
      ticket: 'tkt',
      factors: ['totp'],
    });
    // The ticket is finished with completeTotp, so the client stays anonymous
    // and keeps the challenge in state for a form to read.
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getState().pendingMfa).toEqual({
      ticket: 'tkt',
      factors: ['totp'],
    });
  });

  it('reports passwordless being switched off as unavailable', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          envelope(
            403,
            'PASSKEY_LOGIN_DISABLED',
            'Passwordless sign-in is not available.'
          ),
      }),
      { webAuthn: stubWebAuthn() }
    );

    expect(await auth.signInWithPasskey()).toEqual({
      ok: false,
      reason: 'unavailable',
      code: 'PASSKEY_LOGIN_DISABLED',
      message: 'Passwordless sign-in is not available.',
    });
  });

  it('reports one rejection for an assertion the server would not take', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
        '/api/auth/login/passkey/verify': () =>
          envelope(401, 'PASSKEY_REJECTED'),
      }),
      { webAuthn: stubWebAuthn() }
    );

    expect(await auth.signInWithPasskey()).toMatchObject({
      ok: false,
      reason: 'rejected',
      code: 'PASSKEY_REJECTED',
    });
    expect(auth.getState().status).toBe('anonymous');
  });

  it('reports a dismissed prompt as cancelled', async () => {
    const webAuthn = stubWebAuthn({
      get: () =>
        Promise.reject(
          Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })
        ),
    });
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      }),
      { webAuthn }
    );

    expect(await auth.signInWithPasskey()).toMatchObject({
      ok: false,
      reason: 'cancelled',
    });
    expect(auth.getState().error).toBeNull();
  });

  it('reports an aborted conditional ceremony as cancelled', async () => {
    const webAuthn = stubWebAuthn({
      get: () =>
        Promise.reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' })
        ),
    });
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      }),
      { webAuthn }
    );

    expect(await auth.signInWithPasskey()).toMatchObject({
      reason: 'cancelled',
    });
  });

  it('reports a rate limit with the retry hint', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          envelope(429, undefined, 'Too many attempts.', { retryAfter: '60' }),
      }),
      { webAuthn: stubWebAuthn() }
    );

    expect(await auth.signInWithPasskey()).toMatchObject({
      ok: false,
      reason: 'rate-limited',
      retryAfter: 60,
    });
  });

  it('throws for an error it does not model', async () => {
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () => new Error('offline'),
      }),
      { webAuthn: stubWebAuthn() }
    );

    await expect(auth.signInWithPasskey()).rejects.toThrow();
  });

  it('throws when WebAuthn is absent and no adapter was given', async () => {
    const auth = authWith(routedFetch({}));
    await expect(auth.signInWithPasskey()).rejects.toThrow(/not available/);
  });
});

describe('AuthClient.listPasskeys', () => {
  it('lists the account passkeys with the bearer token', async () => {
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys': () => jsonResponse({ passkeys: [SUMMARY] }),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.listPasskeys();

    expect(outcome).toEqual({ ok: true, passkeys: [parsePasskey(SUMMARY)] });
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).endsWith('/api/auth/passkeys')
    );
    const headers = new Headers((call?.[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer a1');
  });

  it('is an empty list rather than a throw for an unexpected body', async () => {
    const auth = await signedIn(
      passkeyRoutes({ '/api/auth/passkeys': () => jsonResponse({}) })
    );
    expect(await auth.listPasskeys()).toEqual({ ok: true, passkeys: [] });
  });

  it('reports a deployment with passkeys switched off', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys': () => envelope(503, 'PASSKEYS_DISABLED'),
      })
    );
    expect(await auth.listPasskeys()).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('throws when the session ended', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys': () => envelope(401, 'NOT_AUTHENTICATED'),
      })
    );
    await expect(auth.listPasskeys()).rejects.toThrow();
  });
});

describe('AuthClient.renamePasskey', () => {
  it('patches the item path and returns the relabelled passkey', async () => {
    const renamed = { ...SUMMARY, name: 'Work key' };
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/cred_1': () => jsonResponse({ passkey: renamed }),
    });
    const auth = await signedIn(fetchMock);

    const outcome = await auth.renamePasskey('cred_1', 'Work key');

    expect(outcome).toEqual({ ok: true, passkey: parsePasskey(renamed) });
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/passkeys/cred_1')
    );
    expect((call?.[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      name: 'Work key',
    });
  });

  it('escapes a credential id with URL-significant characters', async () => {
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/': () => jsonResponse({ passkey: SUMMARY }),
    });
    const auth = await signedIn(fetchMock);

    await auth.renamePasskey('a/b+c', 'Key');

    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/passkeys/')
    );
    expect(String(call?.[0])).toContain('/passkeys/a%2Fb%2Bc');
  });

  it('reports an empty name as a field error', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/cred_1': () =>
          envelope(422, 'PASSKEY_NAME_REQUIRED', 'A name is required.'),
      })
    );

    expect(await auth.renamePasskey('cred_1', '')).toEqual({
      ok: false,
      reason: 'name-required',
      code: 'PASSKEY_NAME_REQUIRED',
      message: 'A name is required.',
    });
  });

  it('reports a passkey that is not on the account', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/cred_1': () =>
          envelope(404, 'PASSKEY_NOT_FOUND', 'No such passkey.'),
      })
    );

    expect(await auth.renamePasskey('cred_1', 'Key')).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('throws when the rename answers with no passkey', async () => {
    const auth = await signedIn(
      passkeyRoutes({ '/api/auth/passkeys/cred_1': () => jsonResponse({}) })
    );
    await expect(auth.renamePasskey('cred_1', 'Key')).rejects.toThrow(
      /no passkey/
    );
  });
});

describe('AuthClient.deletePasskey', () => {
  it('deletes the item path', async () => {
    const fetchMock = passkeyRoutes({
      '/api/auth/passkeys/cred_1': () => jsonResponse({ deleted: true }),
    });
    const auth = await signedIn(fetchMock);

    expect(await auth.deletePasskey('cred_1')).toEqual({ ok: true });
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/passkeys/cred_1')
    );
    expect((call?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('reports the last credential refusal with the server sentence', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/cred_1': () =>
          envelope(
            409,
            'LAST_CREDENTIAL',
            'Set a password before removing your last passkey.'
          ),
      })
    );

    expect(await auth.deletePasskey('cred_1')).toEqual({
      ok: false,
      reason: 'last-credential',
      code: 'LAST_CREDENTIAL',
      message: 'Set a password before removing your last passkey.',
    });
  });

  it('reports a passkey that is not on the account', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/cred_1': () => envelope(404, 'PASSKEY_NOT_FOUND'),
      })
    );

    expect(await auth.deletePasskey('cred_1')).toMatchObject({
      reason: 'not-found',
    });
  });

  it('leaves the session authenticated after a refusal', async () => {
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/cred_1': () => envelope(409, 'LAST_CREDENTIAL'),
      })
    );

    await auth.deletePasskey('cred_1');

    expect(auth.getState().status).toBe('authenticated');
    expect(auth.getState().error).toBeNull();
  });
});

describe('passkey path overrides', () => {
  it('honours every passkey path override', async () => {
    const fetchMock = routedFetch({
      '/identity/keys': () => jsonResponse({ passkeys: [SUMMARY] }),
    });
    const auth = authWith(fetchMock, { paths: { passkeys: '/identity/keys' } });

    await auth.listPasskeys();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/identity/keys');
  });

  it('derives the item path from the overridden collection', async () => {
    const fetchMock = routedFetch({
      '/identity/keys/cred_1': () => jsonResponse({ deleted: true }),
    });
    const auth = authWith(fetchMock, { paths: { passkeys: '/identity/keys' } });

    await auth.deletePasskey('cred_1');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/identity/keys/cred_1'
    );
  });

  it('uses the overridden login options route', async () => {
    const fetchMock = routedFetch({
      '/identity/pk/options': () =>
        jsonResponse({ challenge_id: 'ch_1', publicKey: {} }),
      '/identity/pk/verify': () =>
        jsonResponse({ access_token: 'a1', expires_in: 600 }),
    });
    const auth = authWith(fetchMock, {
      webAuthn: stubWebAuthn(),
      paths: {
        passkeyLoginOptions: '/identity/pk/options',
        passkeyLoginVerify: '/identity/pk/verify',
      },
    });

    const outcome = await auth.signInWithPasskey();

    expect(outcome).toMatchObject({ ok: true, kind: 'signed-in' });
  });
});

describe('the browser own JSON parsers', () => {
  it('prefers parseCreationOptionsFromJSON when the browser has it', async () => {
    const parse = vi.fn(() => ({ parsed: true }));
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      parseCreationOptionsFromJSON: parse,
    };
    const webAuthn = stubWebAuthn();
    const auth = await signedIn(
      passkeyRoutes({
        '/api/auth/passkeys/register/options': () =>
          jsonResponse({
            challenge_id: 'ch_1',
            publicKey: { challenge: 'Y2hhbA' },
          }),
        '/api/auth/passkeys/register/verify': () =>
          jsonResponse({ registered: true, passkey: SUMMARY }),
      }),
      { webAuthn }
    );

    await auth.registerPasskey();

    expect(parse).toHaveBeenCalledWith({ challenge: 'Y2hhbA' });
    expect(webAuthn.create.mock.calls[0]?.[0]).toEqual({
      publicKey: { parsed: true },
    });
  });

  it('prefers parseRequestOptionsFromJSON when the browser has it', async () => {
    const parse = vi.fn(() => ({ parsed: true }));
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      parseRequestOptionsFromJSON: parse,
    };
    const webAuthn = stubWebAuthn();
    const auth = authWith(
      routedFetch({
        '/api/auth/login/passkey/options': () =>
          jsonResponse({
            challenge_id: 'ch_1',
            publicKey: { challenge: 'Y2hhbA' },
          }),
        '/api/auth/login/passkey/verify': () =>
          jsonResponse({ access_token: 'a1', expires_in: 600 }),
      }),
      { webAuthn }
    );

    await auth.signInWithPasskey();

    expect(parse).toHaveBeenCalledWith({ challenge: 'Y2hhbA' });
    expect(webAuthn.get.mock.calls[0]?.[0]).toEqual({
      publicKey: { parsed: true },
    });
  });
});
