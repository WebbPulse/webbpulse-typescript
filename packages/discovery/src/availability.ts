/**
 * The one-read-per-page-load cache the capability gates share, and the URL
 * shaping every caller of them needs first.
 */

/**
 * What one read concluded. `unknown` means the read could not be made, which is
 * not the same as the capability being switched off, so a caller renders
 * nothing rather than claiming an affordance is unavailable.
 */
export type Availability = 'available' | 'unavailable' | 'unknown';

const cache = new Map<string, Promise<Availability>>();

const memos = new Set<() => void>();

/**
 * Registers an answer map to be emptied by {@link resetAvailabilityCache}.
 * Internal to the package, not part of its public surface.
 */
export function registerMemo(clear: () => void): void {
  memos.add(clear);
}

/**
 * Empties the cache and every answer memoised beside it. For tests only, and
 * one function rather than one per gate so a test cannot reset half of it.
 */
export function resetAvailabilityCache(): void {
  cache.clear();
  for (const clear of memos) {
    clear();
  }
}

/**
 * Runs `probe` at most once per key per page load, keyed by the full requested
 * URL so two bundles pointed at different backends cannot share an answer.
 * Stores the in-flight promise, so concurrent askers join one request, and
 * evicts an `unknown` answer so a dropped request does not hide an affordance
 * for the life of the page.
 */
export function cachedAvailability(
  key: string,
  probe: () => Promise<Availability>
): Promise<Availability> {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = probe().then((result) => {
    if (result === 'unknown') {
      cache.delete(key);
    }
    return result;
  });
  cache.set(key, pending);
  return pending;
}

/** Options for {@link identityOriginFrom}. */
export interface IdentityOriginOptions {
  /**
   * What to return for a root relative base URL such as `/api`. `'empty'`, the
   * default, yields the empty string, so {@link identityUrl} builds a path the
   * browser resolves against the current origin. `'passthrough'` returns the
   * base URL unchanged, which is what an application already shaped that way
   * needs to keep its current behaviour.
   */
  relativeAs?: 'empty' | 'passthrough';
}

/**
 * Strips an API base URL back to its origin, since the discovery paths are
 * already absolute and a `/api` base would send reads to `/api/api/auth/...`.
 * A value that is neither an absolute URL nor a root relative path is returned
 * unchanged, rather than guessed at.
 */
export function identityOriginFrom(
  apiBaseUrl: string,
  options: IdentityOriginOptions = {}
): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    if (apiBaseUrl.startsWith('/')) {
      return options.relativeAs === 'passthrough' ? apiBaseUrl : '';
    }
    return apiBaseUrl;
  }
}

/**
 * Joins an identity origin onto an already absolute route path. An empty origin
 * yields the path alone, which the browser resolves against the current origin.
 */
export function identityUrl(origin: string, path: string): string {
  return origin === '' ? path : `${origin}${path}`;
}
