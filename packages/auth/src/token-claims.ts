/**
 * Reads claims off a JWT access token without verifying it. The server is the
 * only judge of a token; these reads only let a client decide whether asking
 * would be worthwhile.
 */

function decodeBase64Url(segment: string): string | null {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The payload of a JWT as an object, or null when it does not decode. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === '') {
    return null;
  }
  const json = decodeBase64Url(payload);
  if (json === null) {
    return null;
  }
  try {
    const claims: unknown = JSON.parse(json);
    return typeof claims === 'object' &&
      claims !== null &&
      !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `auth_time` claim of a JWT in epoch seconds, or null when the token does
 * not decode or carries no finite numeric `auth_time`.
 */
export function readAuthTime(token: string | null): number | null {
  if (token === null || token === '') {
    return null;
  }
  const value = decodeJwtClaims(token)?.['auth_time'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
