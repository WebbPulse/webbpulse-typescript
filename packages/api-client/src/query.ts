/**
 * Query string serialisation. Array values repeat the key (`ids=1&ids=2`)
 * rather than bracket encoding it, which is what the backends read.
 */

/** A value that can appear in a query string. */
export type QueryValue =
  string | number | boolean | null | undefined | (string | number | boolean)[];

/** The query parameter bag accepted by every request method. */
export type QueryParams = Record<string, QueryValue> | URLSearchParams;

/**
 * Serialises a parameter bag, dropping null and undefined entries. Returns an
 * empty string when nothing survives, so a caller can append it conditionally.
 */
export function serializeQuery(params: QueryParams | undefined): string {
  if (params === undefined) {
    return '';
  }
  if (params instanceof URLSearchParams) {
    return params.toString();
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }
    const encodedKey = encodeURIComponent(key);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined) {
          continue;
        }
        parts.push(`${encodedKey}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * Joins a base URL and a path without doubling or dropping the separator. A
 * trailing slash on the path is preserved: the backends route on it.
 */
export function joinUrl(base: string, path: string): string {
  if (path === '') {
    return base;
  }
  const trimmedBase = base.replace(/\/+$/, '');
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}
