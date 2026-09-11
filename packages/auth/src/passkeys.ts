/**
 * The client half of the identity service's WebAuthn passkey surface. Each
 * ceremony is two round trips with a browser API in between, so
 * {@link AuthClient} runs both legs itself: the challenge is a single use row
 * and holding options across a user interaction strands it.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * One passkey as `GET /passkeys` renders it. The public key is deliberately not
 * in the document: a frontend has no use for it.
 */
export interface Passkey {
  /** base64url, and the identifier the rename and delete routes take. */
  credentialId: string;
  /** The user's label. The server defaults it to `Passkey` when none was given. */
  name: string;
  /** ISO 8601 instant the credential was enrolled. */
  createdAt: string;
  /** ISO 8601 instant of the most recent sign-in through it, when there is one. */
  lastUsedAt: string | undefined;
  /**
   * The transports the authenticator reported. Empty when the browser reported
   * none, which is not an error.
   */
  transports: string[];
  /** The authenticator model's identifier, or `''` when it reported none. */
  aaguid: string;
  /** Whether the credential may be backed up to a provider's cloud. */
  backupEligible: boolean;
  /** Whether it currently is backed up. */
  backupState: boolean;
  /**
   * Whether the authenticator verified the user at enrolment. Such a credential
   * signs in without a second factor later. See {@link PasskeySignedIn}.
   */
  userVerified: boolean;
}

/** The fields every passkey refusal carries. */
interface PasskeyRefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  /** The server's own sentence. Render this rather than a local one. */
  message: string;
}

/**
 * A ceremony the server would not accept. One case rather than five, so neither
 * login route becomes an oracle for which credentials or accounts exist.
 */
export interface PasskeyRejected extends PasskeyRefusalFields {
  reason: 'rejected';
}

/** An authenticator that already holds a credential for some account. */
export interface PasskeyAlreadyRegistered extends PasskeyRefusalFields {
  reason: 'already-registered';
}

/**
 * A delete that would leave the account with no way in. Applies only to the last
 * passkey on an account with no password, and the remedy is to set a password
 * first.
 */
export interface PasskeyLastCredential extends PasskeyRefusalFields {
  reason: 'last-credential';
}

/** A passkey that is not on this account. Usually a stale settings page. */
export interface PasskeyNotFound extends PasskeyRefusalFields {
  reason: 'not-found';
}

/** A rename with an empty name. */
export interface PasskeyNameRequired extends PasskeyRefusalFields {
  reason: 'name-required';
}

/**
 * Passkeys this deployment cannot use: either the capability is off altogether
 * or passwordless sign-in alone is, with `code` telling the two apart. A page
 * should hide the affected control rather than render a failure.
 */
export interface PasskeysUnavailable extends PasskeyRefusalFields {
  reason: 'unavailable';
}

/** A rate limit. */
export interface PasskeyRateLimited extends PasskeyRefusalFields {
  reason: 'rate-limited';
  /** Seconds to wait, when the server said. Read from `Retry-After` first. */
  retryAfter: number | undefined;
}

/**
 * The user dismissed the browser's prompt, or the browser refused to run the
 * ceremony. Not a server refusal, so `code` is always `undefined` and the
 * message is local.
 */
export interface PasskeyCancelled {
  ok: false;
  reason: 'cancelled';
  code: undefined;
  message: string;
}

/** Every refusal the seven routes and the browser can produce. */
export type PasskeyRefusal =
  | PasskeyRejected
  | PasskeyAlreadyRegistered
  | PasskeyLastCredential
  | PasskeyNotFound
  | PasskeyNameRequired
  | PasskeysUnavailable
  | PasskeyRateLimited
  | PasskeyCancelled;

/** A passkey that was enrolled. */
export interface PasskeyRegistered {
  ok: true;
  /** The new credential, exactly as the list route would render it. */
  passkey: Passkey;
}

/** What {@link AuthClient.registerPasskey} resolves to. */
export type PasskeyRegistrationOutcome =
  | PasskeyRegistered
  | PasskeyRejected
  | PasskeyAlreadyRegistered
  | PasskeysUnavailable
  | PasskeyRateLimited
  | PasskeyCancelled;

/**
 * A sign-in that completed. The refresh cookie is set and the access token is
 * held in memory, exactly as after a password login.
 */
export interface PasskeySignedIn {
  ok: true;
  kind: 'signed-in';
  /** The user, when a `loadUser` hook was given or the server embedded one. */
  user: unknown;
  /** Seconds until the access token expires, when the server said. */
  expiresIn: number | undefined;
}

/**
 * A sign-in that still needs a second factor, reached when the authenticator
 * reported no user verification and the account has TOTP enrolled. Finish with
 * `completeTotp({ ticket, code })`, as on the password path.
 */
export interface PasskeyMfaRequired {
  ok: true;
  kind: 'mfa-required';
  /** The single-use ticket to hand to `completeTotp`. */
  ticket: string;
  /** The factors the account can finish with, as the server listed them. */
  factors: string[];
}

/** What {@link AuthClient.signInWithPasskey} resolves to. */
export type PasskeySignInOutcome =
  | PasskeySignedIn
  | PasskeyMfaRequired
  | PasskeyRejected
  | PasskeysUnavailable
  | PasskeyRateLimited
  | PasskeyCancelled;

/** The passkeys on the account. */
export interface PasskeysLoaded {
  ok: true;
  passkeys: Passkey[];
}

/** What {@link AuthClient.listPasskeys} resolves to. */
export type PasskeyListOutcome = PasskeysLoaded | PasskeysUnavailable;

/** A passkey that was relabelled. */
export interface PasskeyRenamed {
  ok: true;
  /** The credential with its new name. */
  passkey: Passkey;
}

/** What {@link AuthClient.renamePasskey} resolves to. */
export type PasskeyRenameOutcome =
  PasskeyRenamed | PasskeyNotFound | PasskeyNameRequired | PasskeysUnavailable;

/** A passkey that was removed. */
export interface PasskeyDeleted {
  ok: true;
}

/** What {@link AuthClient.deletePasskey} resolves to. */
export type PasskeyDeleteOutcome =
  | PasskeyDeleted
  | PasskeyNotFound
  | PasskeyLastCredential
  | PasskeysUnavailable;

/** Where the passkey routes live, relative to the base URL. */
export interface PasskeyPaths {
  /** Defaults to `/api/auth/passkeys/register/options`. */
  passkeyRegisterOptions?: string;
  /** Defaults to `/api/auth/passkeys/register/verify`. */
  passkeyRegisterVerify?: string;
  /** Defaults to `/api/auth/login/passkey/options`. */
  passkeyLoginOptions?: string;
  /** Defaults to `/api/auth/login/passkey/verify`. */
  passkeyLoginVerify?: string;
  /**
   * Defaults to `/api/auth/passkeys`: the collection for the list, and the base
   * the rename and the delete append a credential id to.
   */
  passkeys?: string;
}

/**
 * What the two options routes answer. `publicKey` is WebAuthn JSON passed to the
 * browser untouched; `challengeId` never reaches the browser and goes back on
 * the verify leg.
 */
export interface PasskeyChallenge {
  challengeId: string;
  publicKey: Record<string, unknown>;
}

/**
 * The WebAuthn surface the client uses. Typed structurally rather than against
 * the DOM, so the package type checks in Node and a test can supply a stub,
 * while `navigator.credentials` itself still satisfies it.
 */
export interface WebAuthnAdapter {
  /** Wraps `navigator.credentials.create`. */
  create(options: unknown): Promise<unknown>;
  /** Wraps `navigator.credentials.get`. */
  get(options: unknown): Promise<unknown>;
}

/**
 * Whether this browser can do WebAuthn at all. Call it before rendering a
 * passkey button. False in Node and over plain HTTP, since WebAuthn is a
 * secure-context API.
 */
export function passkeysSupported(): boolean {
  return (
    typeof globalThis === 'object' &&
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !==
      undefined
  );
}

/**
 * Whether this browser can offer passkeys in an autofill dropdown. A separate
 * capability from {@link passkeysSupported}, and async because the answer comes
 * from a promise. Resolves false rather than rejecting when the API is absent.
 *
 * @example
 * ```ts
 * if (await conditionalMediationAvailable()) {
 *   void auth.signInWithPasskey({ mediation: 'conditional' });
 * }
 * ```
 */
export async function conditionalMediationAvailable(): Promise<boolean> {
  const ctor = (
    globalThis as {
      PublicKeyCredential?: {
        isConditionalMediationAvailable?: () => Promise<boolean>;
      };
    }
  ).PublicKeyCredential;
  if (typeof ctor?.isConditionalMediationAvailable !== 'function') {
    return false;
  }
  try {
    return (await ctor.isConditionalMediationAvailable()) === true;
  } catch {
    return false;
  }
}

/**
 * True when a thrown value is the user dismissing the browser's prompt.
 * `NotAllowedError` covers a cancelled or timed out ceremony, which the
 * specification refuses to distinguish, and `AbortError` a torn down
 * conditional sign-in. Recognised by `name`, since `DOMException` is not
 * defined in every runtime this package type checks in.
 */
export function isPasskeyCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** base64url to `ArrayBuffer`, for the fallback conversions. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** `ArrayBuffer` to base64url, for the fallback conversions. */
export function bufferToBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * `PublicKeyCredentialCreationOptionsJSON` to the browser's option object, the
 * fallback for a browser with no `parseCreationOptionsFromJSON`. Converts only
 * the three `BufferSource` fields and copies everything else through untouched.
 */
export function toCreationOptions(
  json: Record<string, unknown>
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...json };
  if (typeof json['challenge'] === 'string') {
    options['challenge'] = base64UrlToBuffer(json['challenge']);
  }
  const user = json['user'];
  if (typeof user === 'object' && user !== null) {
    const fields = user as Record<string, unknown>;
    options['user'] =
      typeof fields['id'] === 'string'
        ? { ...fields, id: base64UrlToBuffer(fields['id']) }
        : { ...fields };
  }
  const exclude = json['excludeCredentials'];
  if (Array.isArray(exclude)) {
    options['excludeCredentials'] = exclude.map(descriptorToBuffers);
  }
  return options;
}

/**
 * `PublicKeyCredentialRequestOptionsJSON` to the browser's option object.
 * Converts the challenge and each `allowCredentials` id; a discoverable request
 * has neither and is left as it arrived.
 */
export function toRequestOptions(
  json: Record<string, unknown>
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...json };
  if (typeof json['challenge'] === 'string') {
    options['challenge'] = base64UrlToBuffer(json['challenge']);
  }
  const allow = json['allowCredentials'];
  if (Array.isArray(allow)) {
    options['allowCredentials'] = allow.map(descriptorToBuffers);
  }
  return options;
}

/** One `PublicKeyCredentialDescriptor`, with its base64url `id` decoded. */
function descriptorToBuffers(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const fields = entry as Record<string, unknown>;
  return typeof fields['id'] === 'string'
    ? { ...fields, id: base64UrlToBuffer(fields['id']) }
    : { ...fields };
}

/**
 * A `PublicKeyCredential` to the JSON the server expects, for a browser whose
 * credentials have no `toJSON`. The ceremonies are told apart by their fields:
 * an attestation has `attestationObject` and an assertion has `signature`.
 * A value that is already a plain object is returned unchanged.
 */
export function credentialToJSON(credential: unknown): Record<string, unknown> {
  if (typeof credential !== 'object' || credential === null) {
    return {};
  }
  const source = credential as Record<string, unknown>;

  if (typeof source['toJSON'] === 'function') {
    const json = (source['toJSON'] as () => unknown)();
    if (typeof json === 'object' && json !== null) {
      return json as Record<string, unknown>;
    }
  }

  const rawId = source['rawId'];
  if (rawId === undefined) {
    return source;
  }

  const response = source['response'];
  const fields =
    typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {
    id: typeof source['id'] === 'string' ? source['id'] : encodeBuffer(rawId),
    rawId: encodeBuffer(rawId),
    type: typeof source['type'] === 'string' ? source['type'] : 'public-key',
    clientExtensionResults:
      typeof source['getClientExtensionResults'] === 'function'
        ? (source['getClientExtensionResults'] as () => unknown)()
        : {},
  };
  if (source['authenticatorAttachment'] != null) {
    out['authenticatorAttachment'] = source['authenticatorAttachment'];
  }

  const inner: Record<string, unknown> = {
    clientDataJSON: encodeBuffer(fields['clientDataJSON']),
  };
  if (fields['attestationObject'] !== undefined) {
    inner['attestationObject'] = encodeBuffer(fields['attestationObject']);
    if (typeof fields['getTransports'] === 'function') {
      inner['transports'] = (fields['getTransports'] as () => unknown)();
    }
  } else {
    inner['authenticatorData'] = encodeBuffer(fields['authenticatorData']);
    inner['signature'] = encodeBuffer(fields['signature']);
    inner['userHandle'] =
      fields['userHandle'] == null ? null : encodeBuffer(fields['userHandle']);
  }
  out['response'] = inner;
  return out;
}

/** base64url for a buffer, passing a string through unchanged. */
function encodeBuffer(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return bufferToBase64Url(value);
  }
  return '';
}

/**
 * Reads a challenge off an options route's body. Both routes answer the same
 * shape, and each field is defended rather than trusted, because this crosses a
 * repository boundary with nothing enforcing it at build time.
 */
export function parsePasskeyChallenge(body: unknown): PasskeyChallenge {
  if (typeof body !== 'object' || body === null) {
    return { challengeId: '', publicKey: {} };
  }
  const record = body as Record<string, unknown>;
  const publicKey = record['publicKey'];
  return {
    challengeId:
      typeof record['challenge_id'] === 'string' ? record['challenge_id'] : '',
    publicKey:
      typeof publicKey === 'object' && publicKey !== null
        ? (publicKey as Record<string, unknown>)
        : {},
  };
}

/** One passkey off a management route's body, defended field by field. */
export function parsePasskey(entry: unknown): Passkey | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const credentialId = record['credential_id'];
  if (typeof credentialId !== 'string' || credentialId === '') {
    return null;
  }
  const lastUsedAt = record['last_used_at'];
  const transports = record['transports'];
  return {
    credentialId,
    name: typeof record['name'] === 'string' ? record['name'] : '',
    createdAt:
      typeof record['created_at'] === 'string' ? record['created_at'] : '',
    lastUsedAt:
      typeof lastUsedAt === 'string' && lastUsedAt !== ''
        ? lastUsedAt
        : undefined,
    transports: Array.isArray(transports)
      ? transports.filter((value): value is string => typeof value === 'string')
      : [],
    aaguid: typeof record['aaguid'] === 'string' ? record['aaguid'] : '',
    backupEligible: record['backup_eligible'] === true,
    backupState: record['backup_state'] === true,
    userVerified: record['user_verified'] === true,
  };
}

/** Reads the `passkeys` array off the list route's body. */
export function parsePasskeys(body: unknown): Passkey[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const raw = (body as { passkeys?: unknown }).passkeys;
  if (!Array.isArray(raw)) {
    return [];
  }
  const passkeys: Passkey[] = [];
  for (const entry of raw) {
    const parsed = parsePasskey(entry);
    if (parsed !== null) {
      passkeys.push(parsed);
    }
  }
  return passkeys;
}

/**
 * Reads a retry hint in seconds off a 429: the `Retry-After` header first, then
 * a `retry_after` in the envelope's `details`.
 */
function retryAfterOf(error: ApiError): number | undefined {
  if (error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds;
  }
  const { details } = getWebbPulseError(error);
  if (details === undefined || Array.isArray(details)) {
    return undefined;
  }
  const value = details['retry_after'];
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : undefined;
}

/**
 * Classifies a thrown error from one of the passkey routes, or returns null.
 * `expected` is the set of reasons the calling method models, so a refusal that
 * is an outcome on one route cannot become a silent success on another. A
 * cancelled browser prompt classifies here too, since both ceremony methods
 * treat it exactly as they treat a server refusal.
 */
export function classifyPasskeyError<
  TReason extends PasskeyRefusal['reason'],
  TRefusal extends PasskeyRefusal = Extract<
    PasskeyRefusal,
    { reason: TReason }
  >,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/**
 * The untyped body of {@link classifyPasskeyError}. Split out because
 * TypeScript cannot prove a concrete reason object satisfies an unresolved
 * `TReason`, so the cast lives here once rather than at each call site.
 */
function classify(
  error: unknown,
  expected: ReadonlySet<PasskeyRefusal['reason']>
): PasskeyRefusal | null {
  if (isPasskeyCancellation(error) && expected.has('cancelled')) {
    return {
      ok: false,
      reason: 'cancelled',
      code: undefined,
      message: 'The passkey prompt was dismissed.',
    };
  }
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

  if (
    rawCode === 'PASSKEY_ALREADY_REGISTERED' &&
    expected.has('already-registered')
  ) {
    return { ...base, reason: 'already-registered' };
  }
  if (rawCode === 'LAST_CREDENTIAL' && expected.has('last-credential')) {
    return { ...base, reason: 'last-credential' };
  }
  if (rawCode === 'PASSKEY_NOT_FOUND' && expected.has('not-found')) {
    return { ...base, reason: 'not-found' };
  }
  if (rawCode === 'PASSKEY_NAME_REQUIRED' && expected.has('name-required')) {
    return { ...base, reason: 'name-required' };
  }
  if (
    (rawCode === 'PASSKEYS_DISABLED' || rawCode === 'PASSKEY_LOGIN_DISABLED') &&
    expected.has('unavailable')
  ) {
    return { ...base, reason: 'unavailable' };
  }
  if (
    (rawCode === 'PASSKEY_REJECTED' ||
      rawCode === 'PASSKEY_CHALLENGE_INVALID' ||
      rawCode === 'CREDENTIAL_REQUIRED') &&
    expected.has('rejected')
  ) {
    return { ...base, reason: 'rejected' };
  }
  if (error.status === 429 && expected.has('rate-limited')) {
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}
