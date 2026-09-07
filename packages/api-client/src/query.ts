/**
 * Query string serialisation.
 *
 * Array values repeat the key (`ids=1&ids=2`) rather than bracket encoding it
 * (`ids[]=1&ids[]=2`). That is load bearing: CarModPicker's `paramsSerializer`
 * does the same, and the backend's `ids` and `category_ids` parameters depend
 * on the repeated form. Both migration inventories flag it as a detail that
 * must survive any extraction, so it is the default here rather than an option.
 */

/** A value that can appear in a query string. */
export type QueryValue =
  string | number | boolean | null | undefined | (string | number | boolean)[];

/** The query parameter bag accepted by every request method. */
export type QueryParams = Record<string, QueryValue> | URLSearchParams;

/**
 * Serialises a parameter bag. Returns an empty string when nothing survives,
 * so a caller can append it conditionally without producing a bare `?`.
 *
 * `null` and `undefined` entries are dropped entirely rather than serialised as
 * the literal strings "null" and "undefined", which is what a naive
 * `String(value)` would send.
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
 * Joins a base URL and a path without doubling or dropping the separator.
 *
 * Trailing slashes on the path are preserved. Portfolio's collection GETs carry
 * a trailing slash, its item routes do not, and its inventory calls the
 * distinction load bearing against the backend's TrailingSlashMiddleware, so
 * this function must not normalise it away.
 */
export function joinUrl(base: string, path: string): string {
  if (path === '') {
    return base;
  }
  const trimmedBase = base.replace(/\/+$/, '');
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}
