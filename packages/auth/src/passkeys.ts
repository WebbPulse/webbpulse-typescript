/**
 * The client half of the identity service's M5 surface: WebAuthn passkeys.
 *
 * Seven routes on the server, and unlike the M6 OAuth set every one of them is
 * an ordinary `fetch`. What is unusual here is not the transport but the fact
 * that each ceremony is **two round trips with a browser API in between**:
 *
 * | Route | What the client does |
 * | --- | --- |
 * | `POST /passkeys/register/options` | fetch options, bearer token |
 * | `POST /passkeys/register/verify` | post what `navigator.credentials.create` returned |
 * | `POST /login/passkey/options` | fetch options, anonymous |
 * | `POST /login/passkey/verify` | post what `navigator.credentials.get` returned |
 * | `GET /passkeys` | ordinary `fetch` with a bearer token |
 * | `PATCH /passkeys/{credential_id}` | rename |
 * | `DELETE /passkeys/{credential_id}` | remove |
 *
 * {@link AuthClient.registerPasskey} and {@link AuthClient.signInWithPasskey}
 * each run both legs, because the two halves are useless apart: the options are
 * spent by exactly one attempt and holding them across a user interaction is
 * how a ceremony ends up half finished with a challenge row already consumed.
 *
 * ## The challenge id is ours and the options are the specification's
 *
 * The options routes answer `{ challenge_id, publicKey }`. The inner document
 * is WebAuthn JSON exactly as the specification defines it, camelCase and all,
 * because it goes straight to the browser and a helpfully renamed field is a
 * field the browser does not understand. `challenge_id` is snake_case with the
 * rest of this API, because it is the server's own handle on the challenge row.
 *
 * The verify routes take `{ challenge_id, credential }`, where `credential` is
 * the browser's response serialised to JSON. So the client has to carry the
 * `challenge_id` from the first leg to the second and must not send it to the
 * browser, which is the whole reason these methods run both legs themselves.
 *
 * **The challenge is a row on the server, not a token, and it is single use.**
 * It is spent by one attempt whatever the outcome, so a failed ceremony cannot
 * be retried with the same options: a retry starts again from the options leg,
 * which is what both methods do naturally by being one call.
 *
 * ## base64url, in both directions
 *
 * WebAuthn's JavaScript API speaks `ArrayBuffer` and the wire speaks
 * base64url, so something has to convert. Recent browsers do it themselves
 * through `PublicKeyCredential.parseCreationOptionsFromJSON`,
 * `parseRequestOptionsFromJSON` and the credential's own `toJSON`, and those
 * are used when present. {@link toCreationOptions}, {@link toRequestOptions}
 * and {@link credentialToJSON} are the fallback for a browser that has neither,
 * and they convert exactly the fields the specification declares as
 * `BufferSource`: nothing else is touched, so an option this version has never
 * heard of still reaches the browser unchanged.
 *
 * The shapes are py_webauthn's `PublicKeyCredentialCreationOptionsJSON` and
 * `PublicKeyCredentialRequestOptionsJSON` going in, and its
 * `RegistrationResponseJSON` and `AuthenticationResponseJSON` coming back.
 *
 * ## Why these return outcomes rather than throwing
 *
 * The same rule the M3 link flows, the M4 MFA flows and the M6 OAuth flows
 * follow: a refusal a page has to render inline is an outcome, and anything a
 * caller could not have anticipated stays an exception. The refusals that
 * matter here are:
 *
 * - `PASSKEY_REJECTED`, the one answer every failed ceremony gets. Wrong
 *   challenge, expired challenge, an assertion that does not verify, a
 *   credential the server does not know and a credential whose user is gone are
 *   deliberately one code with one message, so neither login route becomes an
 *   oracle for which credentials or accounts exist.
 * - `PASSKEY_ALREADY_REGISTERED`, an authenticator enrolled once already. One
 *   answer whether it is on this account or somebody else's, for the same
 *   reason.
 * - `LAST_CREDENTIAL`, the refusal with a specific remedy: this is the only
 *   passkey and there is no password, so deleting it would strand the user
 *   outside their own account. A settings page has to say "set a password
 *   first", and no generic error toast knows to say that.
 * - `PASSKEY_LOGIN_DISABLED`, passwordless sign-in switched off for the
 *   deployment. A sign-in page should hide the button rather than render an
 *   error, which is why it is a named outcome.
 * - `PASSKEYS_DISABLED`, the capability absent altogether.
 * - `PASSKEY_NOT_FOUND`, usually a stale settings page.
 * - `PASSKEY_NAME_REQUIRED`, an empty rename.
 * - a rate limit, which section 5.1 puts at thirty per fifteen minutes on each
 *   login leg and ten per hour on enrolment.
 *
 * ## The one thing that is not a refusal
 *
 * A user who dismisses the browser's passkey prompt gets a `DOMException`, most
 * often `NotAllowedError`, from `navigator.credentials` itself rather than from
 * the server. That is not an error either: it is the same gesture as pressing
 * Cancel on an OAuth consent screen. {@link isPasskeyCancellation} recognises
 * it, and both ceremony methods turn it into a `cancelled` outcome so a page
 * does not show a failure for a user who simply changed their mind.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';

/**
 * One passkey as `GET /passkeys` renders it.
 *
 * The public key is deliberately **not** in this document. It discloses
 * nothing, being public, but a frontend has no use for it and a response body
 * carrying key material invites somebody to start comparing it to something.
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
   * The transports the authenticator reported: `usb`, `nfc`, `ble`,
   * `internal`, `hybrid`. Empty when the browser reported none, which is not an
   * error.
   */
  transports: string[];
  /** The authenticator model's identifier, or `''` when it reported none. */
  aaguid: string;
  /** Whether the credential may be backed up to a provider's cloud. */
  backupEligible: boolean;
  /** Whether it currently is backed up. */
  backupState: boolean;
  /**
   * Whether the authenticator verified the user at enrolment.
   *
   * A credential enrolled with user verification is the one that signs in
   * without a second factor later. See {@link PasskeySignedIn}.
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
 * A ceremony the server would not accept.
 *
 * One case rather than five, because the server answers one code for five
 * reasons on purpose. See the module docstring.
 */
export interface PasskeyRejected extends PasskeyRefusalFields {
  reason: 'rejected';
}

/** An authenticator that already holds a credential for some account. */
export interface PasskeyAlreadyRegistered extends PasskeyRefusalFields {
  reason: 'already-registered';
}

/**
 * A delete that would leave the account with no way in.
 *
 * The remedy is a specific instruction, "set a password first, then remove
 * this passkey", which is why this is a named outcome rather than a thrown 409.
 * It applies only to the last passkey on an account with no password: with two
 * enrolled, either can go.
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
 * Passkeys this deployment cannot use.
 *
 * Either the capability is off altogether (`PASSKEYS_DISABLED`) or passwordless
 * sign-in specifically is off while enrolment still works
 * (`PASSKEY_LOGIN_DISABLED`). Both are deployment configuration rather than
 * user error, and a page should hide the affected control rather than render a
 * failure. `code` tells the two apart when a caller cares.
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
 * ceremony.
 *
 * Not a server refusal at all: this comes from `navigator.credentials`. It is
 * the same gesture as Cancel on an OAuth consent screen and should not be
 * rendered as an error. `code` is always `undefined` and `message` is local,
 * because there was no envelope.
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
 * A sign-in that still needs a second factor.
 *
 * Reached when the authenticator reported **no** user verification and the
 * account has TOTP enrolled. A passkey that verified the user is two factors in
 * one gesture and never lands here. Finish with `completeTotp({ ticket, code })`,
 * the same method the password path uses, because it is the same ticket and the
 * same route.
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
   * Defaults to `/api/auth/passkeys`.
   *
   * The collection for the list, and the base the rename and the delete append
   * a credential id to.
   */
  passkeys?: string;
}

/**
 * What the two options routes answer.
 *
 * `publicKey` is WebAuthn JSON as the specification defines it and is passed to
 * the browser untouched. `challengeId` never reaches the browser: it is the
 * server's handle on the challenge row and goes back on the verify leg.
 */
export interface PasskeyChallenge {
  challengeId: string;
  publicKey: Record<string, unknown>;
}

/**
 * The WebAuthn surface the client uses.
 *
 * Typed structurally rather than against the DOM `CredentialsContainer`, so the
 * package type checks in a Node test run with no `navigator` and a test can
 * supply a stub without constructing a real credential. Both methods take the
 * full `CredentialCreationOptions` / `CredentialRequestOptions` wrapper, so an
 * adapter can be `navigator.credentials` itself.
 */
export interface WebAuthnAdapter {
  /** Wraps `navigator.credentials.create`. */
  create(options: unknown): Promise<unknown>;
  /** Wraps `navigator.credentials.get`. */
  get(options: unknown): Promise<unknown>;
}

/**
 * Whether this browser can do WebAuthn at all.
 *
 * Checks for `PublicKeyCredential` on the global, which is what the
 * specification says is present exactly when the API is. Call it before
 * rendering a "Sign in with a passkey" button: a button that throws when it is
 * pressed is worse than no button.
 *
 * False in Node, in a test run with no DOM, and in a browser served over plain
 * HTTP, since WebAuthn is a secure-context API.
 */
export function passkeysSupported(): boolean {
  return (
    typeof globalThis === 'object' &&
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !==
      undefined
  );
}

/**
 * Whether this browser can offer passkeys in an autofill dropdown.
 *
 * Conditional mediation is what puts a passkey in the same dropdown as a saved
 * username, so a user signs in without pressing a passkey button at all. It is
 * a separate capability from {@link passkeysSupported} and a browser can have
 * one without the other, which is why this is a second function and an async
 * one: the answer comes from a promise.
 *
 * Resolves false rather than rejecting when the API is absent or throws, so a
 * caller can `await` it unconditionally on the render path.
 *
 * @example
 * ```ts
 * if (await conditionalMediationAvailable()) {
 *   // Start a discoverable sign-in that resolves when the user picks a
 *   // passkey from the autofill dropdown, and mark the username input
 *   // autocomplete="username webauthn".
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
    // A browser that has the method but throws is a browser that cannot do it.
    return false;
  }
}

/**
 * True when a thrown value is the user dismissing the browser's prompt.
 *
 * `NotAllowedError` is what every browser raises for a cancelled or timed out
 * ceremony, and the specification is explicit that it must not distinguish the
 * two: telling a caller which one happened would say whether a credential
 * existed. `AbortError` is what an `AbortSignal` produces, which is how a
 * conditional sign-in is torn down when the user submits a password instead.
 *
 * Recognised by `name` rather than with `instanceof DOMException`, because
 * `DOMException` is not defined in every runtime this package type checks in
 * and a test stub raising a plain object with the right `name` should classify
 * the same way a browser's does.
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
 * `PublicKeyCredentialCreationOptionsJSON` to the browser's option object.
 *
 * The fallback for a browser with no `parseCreationOptionsFromJSON`. Exactly
 * three things are `BufferSource` in the creation options: the challenge, the
 * user id, and the id of each entry in `excludeCredentials`. Everything else is
 * copied through untouched, so an option this version has never heard of still
 * reaches the browser.
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
 *
 * Two `BufferSource` fields this time: the challenge, and the id of each entry
 * in `allowCredentials`. A discoverable request has an empty `allowCredentials`
 * or none at all, and both are left as they arrived.
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
 * A `PublicKeyCredential` to the JSON the server expects.
 *
 * The fallback for a browser whose credentials have no `toJSON`. Produces
 * py_webauthn's `RegistrationResponseJSON` or `AuthenticationResponseJSON`
 * depending on which fields the response carries, which is how the two
 * ceremonies are told apart: an attestation has `attestationObject` and an
 * assertion has `signature`.
 *
 * Returns the value unchanged when it is already a plain object, so a test stub
 * can hand back a literal and a browser that did the conversion itself is not
 * converted twice.
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
    // Already plain JSON, from a test stub or a browser that converted for us.
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
    // Registration.
    inner['attestationObject'] = encodeBuffer(fields['attestationObject']);
    if (typeof fields['getTransports'] === 'function') {
      inner['transports'] = (fields['getTransports'] as () => unknown)();
    }
  } else {
    // Authentication.
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
 * Reads a challenge off an options route's body.
 *
 * Both options routes answer the same shape, so one reader serves both.
 * Defends each field rather than trusting the body, because this crosses a
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
 * Reads a retry hint in seconds off a 429.
 *
 * The `Retry-After` header first, which is where the rate limit dependency puts
 * it and which `@webbpulse/api-client` keeps on `ApiError`, then a `retry_after`
 * in the envelope's `details`. The same reader `oauth.ts` uses, for the same
 * reason.
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
 * Classifies a thrown error from one of the seven routes, or returns null.
 *
 * `expected` is the set of reasons the calling method models, so a refusal that
 * is a legitimate outcome on one route cannot become a silent success on
 * another: `listPasskeys` never returns `last-credential`, and one arriving
 * there would be a server bug worth throwing on.
 *
 * A 401 carrying `NOT_AUTHENTICATED` is deliberately **not** classified, for
 * the reason `classifyOAuthError` gives: it means the bearer token was missing
 * or dead, which `@webbpulse/api-client` has already tried to repair with one
 * refresh and one replay, and turning it into an outcome would hide a session
 * that ended behind a settings-page error state.
 *
 * A cancelled browser prompt is classified here too, when the caller models it,
 * because both ceremony methods have to treat it exactly as they treat a server
 * refusal: as a non-exceptional outcome.
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
 * The untyped body of {@link classifyPasskeyError}.
 *
 * Split out for the reason `classify` in `oauth.ts` is: TypeScript cannot prove
 * a concrete `{ reason: 'rate-limited' }` satisfies an unresolved `TReason`,
 * even though the runtime `expected.has` guard is exactly that proof. The cast
 * lives here once rather than at each call site.
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
    // The rate limit dependency raises a bare 429 with no error_code, so this
    // branches on the status rather than on a code that is not there.
    return { ...base, reason: 'rate-limited', retryAfter: retryAfterOf(error) };
  }
  return null;
}
