/**
 * Browser to desktop session handoff. A desktop app opens the web app's handoff
 * page with a PKCE challenge and its custom URL scheme; the signed-in browser
 * mints a single-use code bound to both and hands it back through
 * `<scheme>://auth/handoff?code=...`; the app redeems the code with its verifier
 * for a session of its own. Both sides check the scheme against an allowlist the
 * application configures, mirroring the server's `IDENTITY_DESKTOP_HANDOFF_SCHEMES`.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';
import { bufferToBase64Url } from './passkeys.js';

/** The only challenge method the exchange accepts. */
export const DESKTOP_HANDOFF_CHALLENGE_METHOD = 'S256';

/** The default web page a desktop app opens to start a handoff. */
export const DESKTOP_HANDOFF_PAGE_PATH = '/desktop-handoff';

/** The query parameters the launch URL carries. */
export const DESKTOP_HANDOFF_PARAMS = {
  challenge: 'code_challenge',
  scheme: 'scheme',
} as const;

/** The host and path of the callback URL, `<scheme>://auth/handoff?code=...`. */
export const DESKTOP_HANDOFF_CALLBACK_HOST = 'auth';

/** @see {@link DESKTOP_HANDOFF_CALLBACK_HOST} */
export const DESKTOP_HANDOFF_CALLBACK_PATH = '/handoff';

/** The query parameter the code arrives in on the callback URL. */
export const DESKTOP_HANDOFF_CODE_PARAM = 'code';

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const REFUSED_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'javascript',
  'data',
  'file',
  'blob',
  'about',
  'ws',
  'wss',
  'mailto',
  'vbscript',
  'ftp',
]);

/** Where the two handoff routes live, relative to the base URL. */
export interface DesktopHandoffPaths {
  /** Defaults to `/api/auth/desktop-handoff`. */
  desktopHandoff?: string;
  /** Defaults to `/api/auth/desktop-handoff/exchange`. */
  desktopHandoffExchange?: string;
}

/** A scheme as an allowlist stores it: trimmed, lower case, without `://` or `:`. */
export function normaliseHandoffScheme(value: string): string {
  let scheme = value.trim().toLowerCase();
  if (scheme.endsWith('://')) {
    scheme = scheme.slice(0, -3);
  }
  if (scheme.endsWith(':')) {
    scheme = scheme.slice(0, -1);
  }
  return scheme;
}

/** Whether a normalised scheme is well formed and not a web scheme. */
function isUsableScheme(scheme: string): boolean {
  return SCHEME_PATTERN.test(scheme) && !REFUSED_SCHEMES.has(scheme);
}

/**
 * The allowlist normalised, throwing on an entry that is malformed or a web
 * scheme, so a misconfiguration fails at startup the way the server's does.
 */
export function normaliseHandoffAllowlist(
  schemes: readonly string[]
): readonly string[] {
  const normalised = schemes.map(normaliseHandoffScheme);
  for (const scheme of normalised) {
    if (!isUsableScheme(scheme)) {
      throw new Error(
        `"${scheme}" cannot be a desktop handoff scheme: use a custom scheme such as "myapp".`
      );
    }
  }
  return [...new Set(normalised)];
}

/** Whether `scheme` is on `allowedSchemes`. An empty allowlist allows nothing. */
export function isHandoffSchemeAllowed(
  scheme: string,
  allowedSchemes: readonly string[]
): boolean {
  const candidate = normaliseHandoffScheme(scheme);
  if (!isUsableScheme(candidate)) {
    return false;
  }
  return allowedSchemes.some(
    (entry) => normaliseHandoffScheme(entry) === candidate
  );
}

/** A PKCE pair the desktop app keeps for one handoff. */
export interface DesktopHandoffPkce {
  /** The secret the app holds until the code comes back. Never put it in a URL. */
  verifier: string;
  /** `base64url(SHA-256(verifier))`, the value the launch URL carries. */
  challenge: string;
  method: typeof DESKTOP_HANDOFF_CHALLENGE_METHOD;
}

/** The Web Crypto implementation, which browsers, Electron and Node 20+ all expose. */
function webCrypto(): Crypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.subtle === undefined) {
    throw new Error('Web Crypto is not available in this environment.');
  }
  return crypto;
}

/** The S256 challenge for a verifier. */
export async function desktopHandoffChallenge(
  verifier: string
): Promise<string> {
  const digest = await webCrypto().subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return bufferToBase64Url(digest);
}

/** A fresh 43 character verifier and its S256 challenge. */
export async function createDesktopHandoffPkce(): Promise<DesktopHandoffPkce> {
  const bytes = webCrypto().getRandomValues(new Uint8Array(32));
  const verifier = bufferToBase64Url(bytes);
  return {
    verifier,
    challenge: await desktopHandoffChallenge(verifier),
    method: DESKTOP_HANDOFF_CHALLENGE_METHOD,
  };
}

/** Options for {@link desktopHandoffLaunchUrl}. */
export interface DesktopHandoffLaunchOptions {
  /** The web app's origin, such as `https://app.example.com`. */
  origin: string;
  challenge: string;
  scheme: string;
  allowedSchemes: readonly string[];
  /** The handoff page. Defaults to {@link DESKTOP_HANDOFF_PAGE_PATH}. */
  path?: string;
}

/**
 * The URL a desktop app opens in the system browser to start a handoff. Throws
 * on a scheme off the allowlist or a malformed challenge.
 */
export function desktopHandoffLaunchUrl(
  options: DesktopHandoffLaunchOptions
): string {
  if (!isHandoffSchemeAllowed(options.scheme, options.allowedSchemes)) {
    throw new Error('This scheme is not on the desktop handoff allowlist.');
  }
  if (!CHALLENGE_PATTERN.test(options.challenge)) {
    throw new Error('The challenge is not an S256 PKCE challenge.');
  }
  const url = new URL(
    options.path ?? DESKTOP_HANDOFF_PAGE_PATH,
    options.origin
  );
  url.searchParams.set(DESKTOP_HANDOFF_PARAMS.challenge, options.challenge);
  url.searchParams.set(
    DESKTOP_HANDOFF_PARAMS.scheme,
    normaliseHandoffScheme(options.scheme)
  );
  return url.toString();
}

/** What a launch URL asks for, once validated. */
export interface DesktopHandoffRequest {
  challenge: string;
  scheme: string;
}

/**
 * Reads the challenge and scheme off the launch URL the handoff page was opened
 * with, or null when either is missing, malformed or off the allowlist.
 */
export function readDesktopHandoffRequest(
  href: string,
  allowedSchemes: readonly string[]
): DesktopHandoffRequest | null {
  let url: URL;
  try {
    url = new URL(href, 'https://handoff.invalid');
  } catch {
    return null;
  }
  const challenge =
    url.searchParams.get(DESKTOP_HANDOFF_PARAMS.challenge) ?? '';
  const scheme = url.searchParams.get(DESKTOP_HANDOFF_PARAMS.scheme) ?? '';
  if (!CHALLENGE_PATTERN.test(challenge)) {
    return null;
  }
  if (!isHandoffSchemeAllowed(scheme, allowedSchemes)) {
    return null;
  }
  return { challenge, scheme: normaliseHandoffScheme(scheme) };
}

/**
 * The callback URL that hands a code to the desktop app. Throws on a scheme off
 * the allowlist, so a crafted launch URL can never send a code to a web origin.
 */
export function desktopHandoffCallbackUrl(
  scheme: string,
  code: string,
  allowedSchemes: readonly string[]
): string {
  if (!isHandoffSchemeAllowed(scheme, allowedSchemes)) {
    throw new Error('This scheme is not on the desktop handoff allowlist.');
  }
  const normalised = normaliseHandoffScheme(scheme);
  const query = `${DESKTOP_HANDOFF_CODE_PARAM}=${encodeURIComponent(code)}`;
  return `${normalised}://${DESKTOP_HANDOFF_CALLBACK_HOST}${DESKTOP_HANDOFF_CALLBACK_PATH}?${query}`;
}

/** What a callback URL carries, once validated. */
export interface DesktopHandoffCallback {
  scheme: string;
  code: string;
}

/**
 * Reads the code off the `<scheme>://auth/handoff?code=...` URL the operating
 * system delivered to the desktop app, or null when it is not a handoff
 * callback on an allowed scheme.
 */
export function readDesktopHandoffCallback(
  href: string,
  allowedSchemes: readonly string[]
): DesktopHandoffCallback | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  if (!isHandoffSchemeAllowed(scheme, allowedSchemes)) {
    return null;
  }
  if (
    url.hostname !== DESKTOP_HANDOFF_CALLBACK_HOST ||
    url.pathname !== DESKTOP_HANDOFF_CALLBACK_PATH
  ) {
    return null;
  }
  const code = url.searchParams.get(DESKTOP_HANDOFF_CODE_PARAM) ?? '';
  if (!CODE_PATTERN.test(code)) {
    return null;
  }
  return { scheme: normaliseHandoffScheme(scheme), code };
}

/** Whether a verifier is shaped as RFC 7636 requires. */
export function isDesktopHandoffVerifier(value: string): boolean {
  return VERIFIER_PATTERN.test(value);
}

/** Whether a challenge is shaped as an S256 challenge. */
export function isDesktopHandoffChallenge(value: string): boolean {
  return CHALLENGE_PATTERN.test(value);
}

/** A minted code, and the callback URL to hand it to the desktop app with. */
export interface DesktopHandoffMinted {
  ok: true;
  code: string;
  expiresIn: number;
  /** Assign this to `location` to open the desktop app. */
  callbackUrl: string;
}

/** A desktop session started from a handoff code. */
export interface DesktopHandoffExchanged<TUser> {
  ok: true;
  user: TUser | null;
  expiresIn: number | undefined;
}

interface HandoffRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  message: string;
}

/** The scheme is off the allowlist, on this side or the server's. */
export interface DesktopHandoffSchemeNotAllowed extends HandoffRefusalFields {
  reason: 'scheme-not-allowed';
}

/** The launch URL or the request was malformed. */
export interface DesktopHandoffInvalidRequest extends HandoffRefusalFields {
  reason: 'invalid-request';
}

/** The browser has no session to hand off. Send the person to sign in first. */
export interface DesktopHandoffNotAuthenticated extends HandoffRefusalFields {
  reason: 'not-authenticated';
}

/**
 * The code was unknown, spent, expired, or did not match the verifier or
 * scheme. The server answers all of these alike; start the handoff again.
 */
export interface DesktopHandoffInvalid extends HandoffRefusalFields {
  reason: 'invalid';
}

/** The account may not sign in, or the request came from a disallowed origin. */
export interface DesktopHandoffRefused extends HandoffRefusalFields {
  reason: 'refused';
}

/** The deployment has no handoff schemes configured. */
export interface DesktopHandoffUnavailable extends HandoffRefusalFields {
  reason: 'unavailable';
}

/** Too many attempts from this address. */
export interface DesktopHandoffRateLimited extends HandoffRefusalFields {
  reason: 'rate-limited';
}

/** Every refusal either handoff call can produce. */
export type DesktopHandoffRefusal =
  | DesktopHandoffSchemeNotAllowed
  | DesktopHandoffInvalidRequest
  | DesktopHandoffNotAuthenticated
  | DesktopHandoffInvalid
  | DesktopHandoffRefused
  | DesktopHandoffUnavailable
  | DesktopHandoffRateLimited;

/** What {@link AuthClient.mintDesktopHandoff} resolves to. */
export type DesktopHandoffMintOutcome =
  | DesktopHandoffMinted
  | DesktopHandoffSchemeNotAllowed
  | DesktopHandoffInvalidRequest
  | DesktopHandoffNotAuthenticated
  | DesktopHandoffUnavailable
  | DesktopHandoffRateLimited;

/** What {@link AuthClient.exchangeDesktopHandoff} resolves to. */
export type DesktopHandoffExchangeOutcome<TUser> =
  | DesktopHandoffExchanged<TUser>
  | DesktopHandoffSchemeNotAllowed
  | DesktopHandoffInvalid
  | DesktopHandoffRefused
  | DesktopHandoffUnavailable
  | DesktopHandoffRateLimited;

/** A refusal made on this side, before any request. */
export function desktopHandoffRefusal<
  TReason extends DesktopHandoffRefusal['reason'],
>(
  reason: TReason,
  message: string
): Extract<DesktopHandoffRefusal, { reason: TReason }> {
  return refusalOf(reason, message) as Extract<
    DesktopHandoffRefusal,
    { reason: TReason }
  >;
}

function refusalOf(
  reason: DesktopHandoffRefusal['reason'],
  message: string
): DesktopHandoffRefusal {
  return { ok: false, reason, code: undefined, message };
}

/**
 * Classifies a thrown error from a handoff route, or returns null so the caller
 * rethrows. `expected` keeps a refusal modelled on one route from becoming a
 * silent outcome on the other.
 */
export function classifyDesktopHandoffError<
  TReason extends DesktopHandoffRefusal['reason'],
>(
  error: unknown,
  expected: ReadonlySet<TReason>
): Extract<DesktopHandoffRefusal, { reason: TReason }> | null {
  return classify(error, expected) as Extract<
    DesktopHandoffRefusal,
    { reason: TReason }
  > | null;
}

function classify(
  error: unknown,
  expected: ReadonlySet<DesktopHandoffRefusal['reason']>
): DesktopHandoffRefusal | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const envelope = getWebbPulseError(error);
  const rawCode = envelope.errorCode;
  const base = {
    ok: false as const,
    code: getAuthErrorCode(error),
    message: envelope.message,
  };
  const pick = (
    reason: DesktopHandoffRefusal['reason']
  ): DesktopHandoffRefusal | null =>
    expected.has(reason) ? { ...base, reason } : null;

  if (rawCode === 'HANDOFF_SCHEME_NOT_ALLOWED') {
    return pick('scheme-not-allowed');
  }
  if (rawCode === 'HANDOFF_INVALID_REQUEST') {
    return pick('invalid-request');
  }
  if (rawCode === 'HANDOFF_INVALID') {
    return pick('invalid');
  }
  if (rawCode === 'HANDOFF_DISABLED' || error.status === 404) {
    return pick('unavailable');
  }
  if (error.status === 429) {
    return pick('rate-limited');
  }
  if (error.status === 401) {
    return pick('not-authenticated');
  }
  if (error.status === 403) {
    return pick('refused');
  }
  return null;
}
