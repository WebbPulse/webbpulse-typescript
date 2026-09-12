import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAvailabilityCache } from './availability.js';
import {
  PASSKEY_AVAILABILITY_PATH,
  parsePasskeyCapabilities,
  passkeyCapabilities,
  passkeyEnrolmentAvailability,
  passkeyLoginAvailability,
} from './passkeys.js';

const ORIGIN = 'https://api.example.test';
const AVAILABILITY_URL = `${ORIGIN}${PASSKEY_AVAILABILITY_PATH}`;

const UNKNOWN = { enabled: 'unknown', passwordless: 'unknown' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answering(body: unknown, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body, status)));
}

function notJson(): typeof fetch {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('<html>nope</html>', { status: 200 }))
  );
}

function failing(): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.reject(new TypeError('failed')));
}

function callsOf(fetchImpl: typeof fetch) {
  return vi.mocked(fetchImpl).mock.calls;
}

beforeEach(resetAvailabilityCache);
afterEach(() => {
  resetAvailabilityCache();
  vi.clearAllMocks();
});

describe('PASSKEY_AVAILABILITY_PATH', () => {
  it('is the route the identity package mounts', () => {
    expect(PASSKEY_AVAILABILITY_PATH).toBe('/api/auth/passkeys/availability');
  });
});

describe('parsePasskeyCapabilities', () => {
  it('reads the two booleans', () => {
    expect(
      parsePasskeyCapabilities({ enabled: true, passwordless: true })
    ).toEqual({ enabled: 'available', passwordless: 'available' });
  });

  it('reads passkeys on but not a way in', () => {
    expect(
      parsePasskeyCapabilities({ enabled: true, passwordless: false })
    ).toEqual({ enabled: 'available', passwordless: 'unavailable' });
  });

  it('reads the switched off deployment as a real answer', () => {
    expect(
      parsePasskeyCapabilities({ enabled: false, passwordless: false })
    ).toEqual({ enabled: 'unavailable', passwordless: 'unavailable' });
  });

  it('reads a malformed body as unknown, not as unavailable', () => {
    for (const body of [
      null,
      'nope',
      7,
      {},
      { enabled: 'yes', passwordless: 'no' },
      { enabled: true },
      { passwordless: true },
    ]) {
      expect(parsePasskeyCapabilities(body)).toEqual(UNKNOWN);
    }
  });
});

describe('passkeyCapabilities', () => {
  it('hands back both fields together', async () => {
    await expect(
      passkeyCapabilities(
        AVAILABILITY_URL,
        answering({ enabled: true, passwordless: false })
      )
    ).resolves.toEqual({ enabled: 'available', passwordless: 'unavailable' });
  });

  it('reads it anonymously, with a plain GET and no body', async () => {
    const fetchImpl = answering({ enabled: true, passwordless: true });

    await passkeyCapabilities(AVAILABILITY_URL, fetchImpl);

    expect(callsOf(fetchImpl)[0]?.[0]).toBe(AVAILABILITY_URL);
    expect(callsOf(fetchImpl)[0]?.[1]).toEqual({
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  });

  it('learns nothing from a 404, which is a backend older than the route', async () => {
    await expect(
      passkeyCapabilities(AVAILABILITY_URL, answering({}, 404))
    ).resolves.toEqual(UNKNOWN);
  });

  it('learns nothing from any other non-200', async () => {
    for (const status of [401, 429, 500, 503]) {
      resetAvailabilityCache();
      await expect(
        passkeyCapabilities(AVAILABILITY_URL, answering({}, status))
      ).resolves.toEqual(UNKNOWN);
    }
  });

  it('learns nothing from a network failure', async () => {
    await expect(
      passkeyCapabilities(AVAILABILITY_URL, failing())
    ).resolves.toEqual(UNKNOWN);
  });

  it('learns nothing from a 200 body that is not JSON', async () => {
    const fetchImpl = notJson();

    await expect(
      passkeyCapabilities(AVAILABILITY_URL, fetchImpl)
    ).resolves.toEqual(UNKNOWN);
  });
});

describe('passkeyLoginAvailability', () => {
  it('is available only when the route says passwordless', async () => {
    await expect(
      passkeyLoginAvailability(
        AVAILABILITY_URL,
        answering({ enabled: true, passwordless: true })
      )
    ).resolves.toBe('available');
  });

  it('is unavailable where passkeys are enrolment only', async () => {
    await expect(
      passkeyLoginAvailability(
        AVAILABILITY_URL,
        answering({ enabled: true, passwordless: false })
      )
    ).resolves.toBe('unavailable');
  });

  it('is unknown when nothing was learned', async () => {
    await expect(
      passkeyLoginAvailability(AVAILABILITY_URL, answering({}, 404))
    ).resolves.toBe('unknown');
  });

  it('reads once for two callers in the same tick', async () => {
    const fetchImpl = answering({ enabled: true, passwordless: true });

    await Promise.all([
      passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl),
      passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a switched off answer for the life of the page', async () => {
    const fetchImpl = answering({ enabled: false, passwordless: false });

    await passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl);
    await passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads again after an answer that learned nothing', async () => {
    await expect(
      passkeyLoginAvailability(AVAILABILITY_URL, failing())
    ).resolves.toBe('unknown');

    const succeeding = answering({ enabled: true, passwordless: true });
    await expect(
      passkeyLoginAvailability(AVAILABILITY_URL, succeeding)
    ).resolves.toBe('available');
  });

  it('keys by URL, so a different backend is asked', async () => {
    const fetchImpl = answering({ enabled: true, passwordless: true });

    await passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl);
    await passkeyLoginAvailability(
      `https://other.example.test${PASSKEY_AVAILABILITY_PATH}`,
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('passkeyEnrolmentAvailability', () => {
  it('is the other field of the same answer', async () => {
    await expect(
      passkeyEnrolmentAvailability(
        AVAILABILITY_URL,
        answering({ enabled: true, passwordless: false })
      )
    ).resolves.toBe('available');
  });

  it('shares the one request with the sign in gate', async () => {
    const fetchImpl = answering({ enabled: true, passwordless: false });

    const [login, enrolment] = await Promise.all([
      passkeyLoginAvailability(AVAILABILITY_URL, fetchImpl),
      passkeyEnrolmentAvailability(AVAILABILITY_URL, fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(login).toBe('unavailable');
    expect(enrolment).toBe('available');
  });
});
