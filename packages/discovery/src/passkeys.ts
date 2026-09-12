/**
 * Reads the identity service's passkey availability route to learn what a
 * deployment does with passkeys. One uncredentialed GET, so a sign-in page can
 * ask about the server without spending a rate limit slot or writing a
 * challenge row.
 */

import {
  type Availability,
  cachedAvailability,
  registerMemo,
} from './availability.js';

/** Where the availability route lives, relative to the identity origin. */
export const PASSKEY_AVAILABILITY_PATH = '/api/auth/passkeys/availability';

/**
 * What the route says this deployment does with passkeys. Tri-state on each
 * field rather than boolean, so an unreachable route is not read as a capability
 * being off. The route guarantees that `passwordless` being available implies
 * `enabled` is too.
 */
export interface PasskeyCapabilities {
  /** Whether passkeys can be registered and verified here. */
  enabled: Availability;
  /** Whether a passkey is a way into an account here. */
  passwordless: Availability;
}

const UNKNOWN: PasskeyCapabilities = {
  enabled: 'unknown',
  passwordless: 'unknown',
};

/**
 * Parses the route body into the two answers. Any unrecognised shape yields
 * `unknown` on both fields, since learning nothing is not the same as a
 * capability being off.
 */
export function parsePasskeyCapabilities(body: unknown): PasskeyCapabilities {
  if (typeof body !== 'object' || body === null) {
    return UNKNOWN;
  }
  const { enabled, passwordless } = body as {
    enabled?: unknown;
    passwordless?: unknown;
  };
  if (typeof enabled !== 'boolean' || typeof passwordless !== 'boolean') {
    return UNKNOWN;
  }
  return {
    enabled: enabled ? 'available' : 'unavailable',
    passwordless: passwordless ? 'available' : 'unavailable',
  };
}

async function readCapabilities(
  url: string,
  fetchImpl: typeof fetch
): Promise<PasskeyCapabilities> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  } catch {
    return UNKNOWN;
  }
  if (response.status !== 200) {
    return UNKNOWN;
  }
  try {
    return parsePasskeyCapabilities(await response.json());
  } catch {
    return UNKNOWN;
  }
}

const answers = new Map<string, PasskeyCapabilities>();

registerMemo(() => answers.clear());

/**
 * What this deployment does with passkeys, read at most once per page load and
 * keyed by the full URL. An answer that learned nothing is not memoised, so the
 * next ask tries again. `url` is the whole URL: build it with `identityUrl` and
 * {@link PASSKEY_AVAILABILITY_PATH}.
 */
export function passkeyCapabilities(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PasskeyCapabilities> {
  return cachedAvailability(url, async () => {
    const capabilities = await readCapabilities(url, fetchImpl);
    if (capabilities.passwordless === 'unknown') {
      return 'unknown';
    }
    answers.set(url, capabilities);
    return capabilities.passwordless;
  }).then(() => answers.get(url) ?? UNKNOWN);
}

/** Whether passwordless passkey sign-in is offered here. */
export function passkeyLoginAvailability(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<Availability> {
  return passkeyCapabilities(url, fetchImpl).then(
    (capabilities) => capabilities.passwordless
  );
}

/**
 * Whether passkeys can be registered here at all. Shares the one request with
 * {@link passkeyLoginAvailability}.
 */
export function passkeyEnrolmentAvailability(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<Availability> {
  return passkeyCapabilities(url, fetchImpl).then(
    (capabilities) => capabilities.enabled
  );
}
