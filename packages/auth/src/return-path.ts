/**
 * Validation for the post sign-in destinations a URL carries, such as
 * `/login?returnTo=...`, so a crafted link can never bounce a visitor to
 * another origin.
 */

const PROBE_ORIGIN = 'https://return-path.invalid';

const MAX_DECODE_PASSES = 3;

/** Whether `value` holds a backslash or a control character. */
function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c || code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Options for {@link safeReturnPath} and {@link isSafeReturnPath}. */
export interface SafeReturnPathOptions {
  /**
   * Pathnames refused even though they are local, such as the sign-in page
   * itself, so a return never loops back onto the page that read it.
   */
  excludePaths?: readonly string[];
}

/** Whether one spelling of a candidate looks like a same-origin path. */
function isLocalSpelling(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !hasUnsafeCharacter(value)
  );
}

/**
 * Every spelling of `value` a browser or router might act on: the raw value
 * and each percent-decoded layer, or null when a layer is malformed.
 */
function spellings(value: string): string[] | null {
  const found = [value];
  let current = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) {
      return found;
    }
    found.push(decoded);
    current = decoded;
  }
  return /%[0-9a-f]{2}/i.test(current) ? null : found;
}

/**
 * Whether `value` is an in-app path that is safe to navigate to after sign-in.
 *
 * Accepts only a root relative path. Refuses protocol relative `//host`, any
 * backslash (which browsers read as a slash), control characters (which
 * browsers strip, so `/\t/host` becomes `//host`), schemes such as
 * `javascript:`, any of those hidden behind percent encoding, malformed
 * encoding, and anything that would resolve off the page's own origin.
 */
export function isSafeReturnPath(
  value: unknown,
  options: SafeReturnPathOptions = {}
): value is string {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  const variants = spellings(value);
  if (variants === null || !variants.every(isLocalSpelling)) {
    return false;
  }
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return false;
  }
  if (resolved.origin !== PROBE_ORIGIN) {
    return false;
  }
  const excluded = options.excludePaths ?? [];
  return !excluded.includes(resolved.pathname);
}

/**
 * `value` when {@link isSafeReturnPath} accepts it, otherwise `fallback`.
 * Read a `returnTo` query parameter through this before navigating to it.
 */
export function safeReturnPath(
  value: unknown,
  fallback = '/',
  options: SafeReturnPathOptions = {}
): string {
  return isSafeReturnPath(value, options) ? value : fallback;
}

/** Options for {@link identityReturnUrl}. */
export interface IdentityReturnUrlOptions {
  /**
   * The identity origin the URL must sit on. An empty or root relative value
   * means the page's own origin, matching `identityOriginFrom`.
   */
  identityOrigin: string;
  /** The exact pathname the URL must have, such as `/api/auth/authorize`. */
  path: string;
  /**
   * The page's own origin, used when `identityOrigin` is empty or relative.
   * Defaults to `globalThis.location.origin` where there is one.
   */
  pageOrigin?: string;
}

/** The current page's origin, or undefined outside a browser. */
function currentPageOrigin(): string | undefined {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  return typeof location?.origin === 'string' ? location.origin : undefined;
}

/**
 * The absolute URL to hand the browser back to after sign-in, or null.
 *
 * Accepts only an absolute http or https URL on the identity origin whose
 * pathname is exactly `path`, such as the MCP authorize endpoint or the device
 * approval page, with its query. Credentials and fragments are refused rather
 * than stripped, so the parameter cannot be used as an open redirect.
 */
export function identityReturnUrl(
  value: string | null | undefined,
  options: IdentityReturnUrlOptions
): string | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  const pageOrigin = options.pageOrigin ?? currentPageOrigin();
  let target: URL;
  let expected: URL;
  try {
    target = new URL(value);
    expected = new URL(
      options.identityOrigin || (pageOrigin ?? ''),
      pageOrigin
    );
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return null;
  }
  if (
    target.origin !== expected.origin ||
    target.pathname !== options.path ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== ''
  ) {
    return null;
  }
  return target.href;
}
