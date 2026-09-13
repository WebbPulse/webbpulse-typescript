# @webbpulse/auth

The frontend half of the WebbPulse unified identity standard, sections 7.1 to
7.3. Framework free, with the React bindings in a separate entry so an
application importing only the core never pulls React into its bundle.

```ts
import { createAuthClient } from '@webbpulse/auth';
import { createApiClient } from '@webbpulse/api-client';

const auth = createAuthClient<UserRead>({
  baseUrl: config.apiBaseUrl,
  loadUser: (client) => client.get<UserRead>('/users/me').then((r) => r.data),
  onSessionEnded: () => router.navigate('/login'),
});

const client = createApiClient({ baseUrl: config.apiBaseUrl, auth });
```

```tsx
import { AuthProvider, useAuth } from '@webbpulse/auth/react';

<AuthProvider client={auth} onSessionEnded={() => navigate('/login')}>
  <App />
</AuthProvider>;

const { status, user, isAuthenticated, login, logout } = useAuth<UserRead>();
```

## How the session is held

The access token lives in a private field and nowhere else: no `localStorage`,
no `sessionStorage`, no readable cookie, no module level variable. The refresh
token is an httpOnly cookie scoped to `Path=/api/auth`, so every call sets
`credentials: 'include'`.

- **One refresh is in flight at a time.** The server treats a second
  presentation of a consumed refresh token as reuse and revokes the whole
  family, so a concurrent rotation would sign out a healthy session.
- **The proactive refresh fires at 80% of `expires_in`.** Move it with
  `proactiveRefreshRatio`, or set `disableProactiveRefresh` in a test or under
  server side rendering, where a dangling timer keeps the process alive.
- **A first time visitor with no cookie is not a session ending.** They get
  `status: 'anonymous'`, a null `sessionEnded` and no `onSessionEnded` call.
- **`status` is one field**: `unknown`, `loading`, `authenticated` or
  `anonymous`. The distinct `unknown` prevents a frame of signed out UI on first
  paint.
- **`loadUser` receives a client that carries the access token**, so a route
  behind the gateway authorizer resolves. Passing your own `client` option opts
  out of that: give it a `getAuthToken` of your own.

## Which flag a route guard gates on

`status` moves to `'loading'` for the duration of every session call, so a guard
gating on it unmounts whatever is driving that call, and a login form unmounted
mid-request loses the MFA challenge about to arrive. Gate on these instead. From
0.10.5:

| Flag              | Means                                                             | Gate this on it           |
| ----------------- | ----------------------------------------------------------------- | ------------------------- |
| `isLoading`       | The session has never settled. Latches false on the first answer. | The first-paint spinner.  |
| `isBusy`          | A session call is in flight, settled or not.                      | A button spinner, a form. |
| `isAuthenticated` | A session is held, including during a call on a live session.     | A redirect.               |

```tsx
const { isAuthenticated, isLoading } = useAuth<UserRead>();

if (isLoading) return <Spinner />;
if (!isAuthenticated) return <Navigate to="/login" replace />;
return <Outlet />;
```

`isAuthenticated` is not a bare `status === 'authenticated'`: `useAuth` keeps it
true while a call is in flight and the token is still held, and `useSession`
does the same from `hadUser`, so a guard cannot eject a signed in user
mid-refresh. A guest guard that bounces a signed in user off the login page
waits on `!isBusy` as well, so it does not fire mid-login.

## Reading and writing the user

```ts
auth.setUser(user); // no request, no rotation, leaves `status` alone
await auth.reloadUser(); // re-reads through `loadUser`, rotates nothing
```

Use these rather than `refresh` after a profile edit: every rotation is a chance
for the reuse detector to end a healthy session. A 401 from `reloadUser` ends
the session as a failed refresh does and resolves to null; any other failure
leaves the session alone and lands in `error`.

## The session ending, from React

`AuthState.sessionEnded` carries the `AuthSessionEndedError` for the current
ending, or null. Read it with `useSessionEnded`, or off `useAuth` and
`useAuthState`. `AuthProvider` also takes an `onSessionEnded` prop, which fires
on top of the client's own option:

```tsx
<AuthProvider
  client={auth}
  onSessionEnded={(error) => {
    navigate(error.reason === 'logged-out' ? '/' : '/login?expired=1');
  }}
>
```

- It fires on an ordinary 401 expiry, which is why `error` cannot stand in:
  `error` stays null on a 401 refusal.
- Exactly once per ending, StrictMode's double mount included. The handler need
  not be memoised.
- It does not fire when the startup refresh found no cookie.
- `sessionEnded` clears on the next successful `login` or `initialize`. A failed
  login leaves it alone.

`reason` is `'refresh-failed'`, `'logged-out'` or `'no-session'`.

## Testing a component under the provider

`AuthProvider` calls `initialize` on mount and `useAuthState` calls `getState`
and `subscribe`, so those three are the floor. Every other method is bound on
first read, so a stub needs only what the component calls:

```tsx
const client = {
  initialize: () => Promise.resolve(null),
  getState: () => ({
    status: 'authenticated',
    user: ALICE,
    hasAccessToken: true,
    error: null,
    sessionEnded: null,
    pendingMfa: null,
  }),
  subscribe: () => () => {},
  logout: vi.fn(() => Promise.resolve()),
} as unknown as AnyAuthClient;

render(
  <AuthProvider client={client}>
    <SignOutButton />
  </AuthProvider>
);
```

`initializeOnMount={false}` drops the `initialize` stub too. Reading a key the
stub does not implement is what throws, naming the method. Each wrapper is
cached per client instance, so it is stable in a dependency array.

## MFA

```ts
const outcome = await auth.login({ email, password });
if (outcome.mfaRequired) {
  await auth.completeTotp({ ticket: outcome.ticket, code });
}

await auth.enrolTotp(); // { secret, provisioningUri }
await auth.activateTotp({ code }); // { recoveryCodes }
await auth.disableTotp({ code }); // { ok: true }
await auth.regenerateRecoveryCodes({ code }); // { recoveryCodes }
await auth.stepUp({ code }); // adopts a fresher access token
```

The first login leg answers 200 with the challenge, not 401: nothing was
refused, so `mfaRequired` is a branch on success. The ticket is also in
`state.pendingMfa` for a component that navigated between the two steps.

Enrol, show the QR from `provisioningUri` with `secret` as the typed fallback,
then activate with the first code. The factor is inactive until activation, and
recovery codes exist only from then. This package renders no QR code; hand the
URI to a generator such as `@webbpulse/qrcode`.

- **Every `code` takes a TOTP code or an unspent recovery code**, told apart by
  shape, on all four routes that verify one.
- **Both secrets are shown exactly once.** No route reads a seed back, and the
  server stores only hashes of the recovery codes. `regenerateRecoveryCodes`
  replaces every code, so it cannot recover a lost printout. Say so on screen.
- **`invalid-code` is one refusal covering six causes**, so the second login leg
  cannot reveal which accounts have TOTP. Render `outcome.message`.
- **`stepUp` is not a second login.** No refresh family starts and the cookie is
  untouched. The new token carries a fresh `auth_time` and a widened `amr`, and
  is adopted into the store, so it is not in the outcome.

Refusal reasons: `invalid-code`, `already-enabled`, `no-pending-enrolment`,
`rate-limited`, `unavailable`. These return outcomes rather than throwing, and
reject only for a network failure, a 500, or a 401 the client could not repair.

`paths`: `totpEnrol`, `totpActivate`, `totpDisable`, `recoveryCodes`, `stepUp`.

## Email verification and password reset

```ts
await auth.requestEmailVerification({ email }); // anonymous
await auth.requestPasswordReset({ email }); // anonymous
await auth.confirmEmailVerification({ token });
await auth.confirmPasswordReset({ token, newPassword });

import { readLinkToken, RESET_PASSWORD_PATH } from '@webbpulse/auth';
const token = readLinkToken({ expectedPath: RESET_PASSWORD_PATH });
```

- **Pass `expectedPath`.** A single page handling both links would otherwise
  present a verification token to the reset endpoint, which the backend refuses
  as wrong-purpose.
- **`VERIFY_EMAIL_PATH` and `RESET_PASSWORD_PATH` are SPA paths, not API
  routes**, and must equal `VERIFY_LINK_PATH` and `RESET_LINK_PATH` in the
  backend's `webbpulse.identity.verification`. Nothing enforces that across the
  two repositories at build time, so both sides carry a test on the literal.
- **The request routes never say whether the address exists.** Unknown, already
  verified and just-sent all answer 200 with the same body, and
  `EmailRequestOutcome` has no `sent: false`. Render the server's copy.
- **A successful reset revokes every refresh family**, this browser's included,
  so `confirmPasswordReset` drops the client's own token. It does not fire
  `onSessionEnded`; the reset page's success branch navigates.

Refusal reasons: `invalid-link`, `password-rejected`, `rate-limited`,
`unavailable`. These return outcomes rather than throwing.

`paths`: `verifyEmail`, `verifyEmailConfirm`, `passwordReset`,
`passwordResetConfirm`.

## OAuth

Google and GitHub. Two of the five routes are browser navigations, so the
surface is not five methods of one shape.

```tsx
<a href={auth.oauthStartUrl('google', { returnTo: '/dashboard' })}>
  Sign in with Google
</a>
```

`oauthStartUrl` is a builder because the start route answers 302 to the provider
and script cannot follow a cross-origin redirect. `startOAuth` is the same URL
plus the navigation, returning void because the page is leaving.

The callback runs on the API and redirects back with the refresh cookie already
set: there is no code to exchange. One query parameter says what happened.

| Parameter             | Meaning                         | What to do                            |
| --------------------- | ------------------------------- | ------------------------------------- |
| `?oauth=1`            | signed in, refresh cookie set   | `await auth.initialize()`             |
| `?mfa_ticket=<t>`     | the account has a second factor | `auth.completeTotp({ ticket, code })` |
| `?oauth_linked=1`     | a provider was attached         | reload the links list                 |
| `?oauth_error=<CODE>` | refused, or the user cancelled  | render the code                       |

`useOAuthCallback` does the read, the StrictMode guard and the
`history.replaceState` cleanup in one:

```tsx
import { useOAuthCallback } from '@webbpulse/auth/react';

useOAuthCallback(async (result) => {
  switch (result.kind) {
    case 'signed-in':
      await auth.initialize();
      break;
    case 'mfa-required':
      setPendingTicket(result.ticket);
      break;
    case 'linked':
      await reloadLinks();
      break;
    case 'error':
      setBanner(describeOAuthCallbackError(result));
      break;
  }
});
```

Outside React, use `readOAuthCallback(href)`, which returns null on an ordinary
visit, then `stripOAuthParams` with `history.replaceState`. Precedence is fixed:
error, ticket, link, sign-in.

```ts
const { links } = await auth.listOAuthLinks();
const started = await auth.linkOAuthProvider('github', {
  returnTo: '/settings',
});
if (started.ok) window.location.assign(started.authorizationUrl);
const removed = await auth.unlinkOAuthProvider('github');
```

- **The access token is never in the URL.** The MFA ticket is, because the
  browser is mid-navigation; it is short-lived and single use, so strip it as
  soon as it is read, which `useOAuthCallback` does.
- **`linkOAuthProvider` answers with a URL rather than redirecting**, since it
  is called over `fetch` with an `Authorization` header and a redirect would be
  followed without it.
- **`last-sign-in-method` is the one refusal with a specific remedy**: set a
  password first, then unlink. Render the server's sentence.

Refusal reasons: `already-linked`, `not-linked`, `last-sign-in-method`,
`provider-unavailable`, `rate-limited`, the last carrying `retryAfter` in
seconds. A network failure, a 500 and an unrepairable 401 throw.

`paths`: `oauthStart` (default `/api/auth/oauth`, with the provider and `/start`
or `/link` appended) and `oauthLinks`.

## Passkeys

Each ceremony is two round trips with a browser API between them.
`registerPasskey` and `signInWithPasskey` run both legs, because the challenge is
a single-use row spent by one attempt whatever the outcome; a failed attempt
starts again by calling the method again.

```ts
import {
  passkeysSupported,
  conditionalMediationAvailable,
} from '@webbpulse/auth';

await auth.registerPasskey({ name: 'MacBook Touch ID' });

const signIn = await auth.signInWithPasskey();
if (signIn.ok && signIn.kind === 'mfa-required') {
  setPendingTicket(signIn.ticket);
}

await auth.listPasskeys();
await auth.renamePasskey(credentialId, 'Work key');
await auth.deletePasskey(credentialId);
```

`passkeysSupported()` is `window.PublicKeyCredential` being present, so it is
false in Node, in a test with no DOM, and over plain HTTP.
`conditionalMediationAvailable()` is the separate capability that puts a passkey
in the autofill dropdown; a browser can have one without the other. For autofill,
check it and pass an `AbortSignal` so the ceremony can be torn down:

```ts
if (await conditionalMediationAvailable()) {
  void auth.signInWithPasskey({
    mediation: 'conditional',
    signal: controller.signal,
  });
}
```

Omit `email` for the discoverable flow; pass one when the form already collected
an address, which produces an `allowCredentials` list. `name` is trimmed, capped
at 64 characters and replaced with `Passkey` when empty.

- **Both registration legs are authorized**, so the method rejects with
  `AuthSessionEndedError` rather than opening a prompt with no session.
- **An unknown address is indistinguishable from a known one.** Any address gets
  a challenge and an empty list, so this route is not an account oracle.
- **`kind: 'mfa-required'`** means the authenticator reported no user
  verification and the account has TOTP. Finish with `completeTotp`, the same
  ticket the password path uses. A passkey that verified the user signs in
  outright.
- **`last-credential`** is a delete that would leave no password and no passkey.
  Remedy: set a password first. It applies only to the last one.
- **`rejected` is one outcome for five causes**, and `already-registered` is one
  answer whether the authenticator is enrolled here or elsewhere, so neither
  login route becomes an oracle.
- **`unavailable` covers `PASSKEYS_DISABLED` and `PASSKEY_LOGIN_DISABLED`**:
  passkeys off, or passwordless sign-in off while enrolment still works. Both
  are deployment configuration, so hide the control. `code` tells them apart.
- **`cancelled` does not come from the server.** A dismissed prompt is a
  `DOMException`, recognised by `isPasskeyCancellation`, not an error to render.

`listPasskeys` returns the credential id, label, two timestamps, reported
transports, `aaguid`, the backup flags and whether the user was verified at
enrolment. The public key is deliberately absent.

The browser's own `parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`
and `toJSON` are used when they exist; `toCreationOptions`, `toRequestOptions`
and `credentialToJSON` are the fallback, converting exactly the fields the
specification declares as `BufferSource` and copying the rest through. Wire
shapes are py_webauthn's. `navigator.credentials` is injected through the
`webAuthn` option, which takes the whole `CredentialCreationOptions` wrapper so
a conditional sign-in can pass `mediation` and `signal`.

`paths`: `passkeyRegisterOptions`, `passkeyRegisterVerify`,
`passkeyLoginOptions`, `passkeyLoginVerify`, `passkeys`.

## Errors

`getAuthErrorCode(error)` returns one of `AUTH_ERROR_CODES` or `undefined`, so a
`switch` falls through to a generic path rather than matching a string nobody
promised. `describeAuthError(error, fallback?)` gives a renderable message.

```ts
switch (getAuthErrorCode(error)) {
  case 'INVALID_CREDENTIALS':
    setFieldError('password', 'Wrong email or password.');
    break;
  case 'ACCOUNT_LOCKED':
  case 'RATE_LIMITED':
    setBanner(describeAuthError(error));
    break;
  default:
    setBanner(describeAuthError(error, 'Could not sign in.'));
}
```

`AUTH_ERROR_CODES` covers the twelve codes section 7.3 names plus the codes the
link, MFA, OAuth and passkey routes emit. One trap: `PASSKEY_NOT_RECOGNISED` is
7.3's own code, keeps its British spelling, and is a different thing from
`PASSKEY_REJECTED`, which is what the passkey routes actually emit for a ceremony
that did not verify.

The refresh cannot recurse: `/api/auth/refresh` is called with retries disabled,
and the 401 retry in `@webbpulse/api-client` calls `requestOnce` at most twice,
with `skipAuthRetry` on the replay.

## `SessionManager`

Not the identity standard's mechanism. It survives for the plain session cookie
Portfolio's admin panel uses today, and it is cookie only: `mode: 'token'`,
`tokenStorageKey`, `tokenStorage`, `extractToken`, `getToken`, `setToken`,
`TokenStore`, `MemoryTokenStorage`, `defaultTokenStorage` and `TokenStorage` are
gone. `isLoginComplete` replaces `extractToken` as the hook that says whether a
login response finished the sign in or is waiting on a second factor. New code
should use `AuthClient`.

## Exports

`@webbpulse/auth`

- Client: `AuthClient`, `createAuthClient`, `SessionManager`.
- Errors: `AUTH_ERROR_CODES`, `AuthSessionEndedError`, `getAuthErrorCode`,
  `isAuthErrorCode`, `describeAuthError`.
- Link flows: `VERIFY_EMAIL_PATH`, `RESET_PASSWORD_PATH`, `LINK_TOKEN_PARAM`,
  `readLinkToken`, `retryAfterSeconds`, `classifyLinkError`.
- MFA: `TOTP_FACTOR`, `classifyMfaError`.
- OAuth: `GOOGLE_PROVIDER`, `GITHUB_PROVIDER`, `readOAuthCallback`,
  `stripOAuthParams`, `parseOAuthLinks`, `describeOAuthCallbackError`,
  `classifyOAuthError`, and the `OAUTH_*` parameter constants.
- Passkeys: `passkeysSupported`, `conditionalMediationAvailable`,
  `isPasskeyCancellation`, `toCreationOptions`, `toRequestOptions`,
  `credentialToJSON`, `base64UrlToBuffer`, `bufferToBase64Url`, `parsePasskey`,
  `parsePasskeys`, `parsePasskeyChallenge`, `classifyPasskeyError`.

Types accompany each group, including `AuthClientOptions`, `AuthState`,
`AuthStatus`, `AuthErrorCode`, `AuthPaths`, `LoginOutcome`, `MfaChallenge`,
`PasswordCredentials`, `WebAuthnAdapter` and the outcome unions for every flow.

`@webbpulse/auth/react`

`AuthProvider`, `useAuth`, `useAuthClient`, `useAuthState`, `useSessionEnded`,
`useOAuthCallback`, `SessionProvider`, `useSession`, `useSessionState`,
`useSessionManager`, with `AuthProviderProps`, `UseAuthResult`, `AnyAuthClient`,
`SessionProviderProps`, `UseSessionResult`, `AnySessionManager` and
`OAuthCallbackHandler`.
