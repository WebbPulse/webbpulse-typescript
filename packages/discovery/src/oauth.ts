/**
 * Reads the identity service's OAuth provider discovery route to learn which
 * providers a deployment has configured, so a sign-in page renders the real set
 * rather than a guess. One uncredentialed GET rather than a probe per provider.
 */

import { GITHUB_PROVIDER, GOOGLE_PROVIDER } from '@webbpulse/auth';

import { cachedAvailability, registerMemo } from './availability.js';

/** Where the discovery route lives, relative to the identity origin. */
export const OAUTH_PROVIDERS_PATH = '/api/auth/oauth/providers';

/**
 * One provider the deployment says it can sign a user in with. `displayName` is
 * camelCase here while the wire sends `display_name`, since the wire shape is
 * the backend's convention and this is a TypeScript surface.
 */
export interface OAuthProviderInfo {
  /** The provider id, `google` or `github` in the baseline. */
  id: string;
  /** The name to show a user. */
  displayName: string;
}

/**
 * A human name for a provider id, for copy that has only the id. Names the two
 * baseline providers from the constants `@webbpulse/auth` owns, so the two
 * cannot drift, and title cases anything else rather than showing a raw wire
 * value.
 */
export function providerLabel(provider: string): string {
  switch (provider) {
    case GOOGLE_PROVIDER:
      return 'Google';
    case GITHUB_PROVIDER:
      return 'GitHub';
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

/**
 * Parses the route body into a provider list, dropping each entry without a
 * usable `id` individually so one malformed record cannot hide the rest, and
 * falling back to {@link providerLabel} for a missing name. Returns `undefined`
 * for a body that is not the documented envelope, which is nothing learned
 * rather than a deployment with no providers.
 */
export function parseProviders(body: unknown): OAuthProviderInfo[] | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const raw = (body as { providers?: unknown }).providers;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const providers: OAuthProviderInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as { id?: unknown; display_name?: unknown };
    if (typeof record.id !== 'string' || record.id === '') {
      continue;
    }
    const name = record.display_name;
    providers.push({
      id: record.id,
      displayName:
        typeof name === 'string' && name !== ''
          ? name
          : providerLabel(record.id),
    });
  }
  return providers;
}

async function readProviders(
  url: string,
  fetchImpl: typeof fetch
): Promise<OAuthProviderInfo[] | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  } catch {
    return undefined;
  }
  if (response.status !== 200) {
    return undefined;
  }
  try {
    return parseProviders(await response.json());
  } catch {
    return undefined;
  }
}

const lists = new Map<string, OAuthProviderInfo[]>();

registerMemo(() => lists.clear());

/**
 * The providers to draw buttons for, in the order the deployment listed them,
 * read at most once per page load and keyed by the full URL. Resolves to `[]`
 * both when none are configured and when nothing could be learned, so a caller
 * never draws a button that cannot work; the difference is in the caching, since
 * "none configured" is a deployment fact and a failed read is retried. `url` is
 * the whole URL: build it with `identityUrl` and {@link OAUTH_PROVIDERS_PATH}.
 */
export function oauthProviders(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<OAuthProviderInfo[]> {
  return cachedAvailability(url, async () => {
    const providers = await readProviders(url, fetchImpl);
    if (providers === undefined) {
      return 'unknown';
    }
    lists.set(url, providers);
    return providers.length > 0 ? 'available' : 'unavailable';
  }).then(() => lists.get(url) ?? []);
}
