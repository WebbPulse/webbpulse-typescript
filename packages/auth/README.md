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
await auth.stepUpWithPasskey(); // the same, from a passkey assertion
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
- **`stepUpWithPasskey` is the same step-up run against a factor** rather than a
  typed code, for gating a sensitive action on a passkey. It runs an options leg
  scoped to the signed-in caller, with `userVerification: 'required'`, then
  verifies the assertion on the step-up route itself, adopting the token exactly
  as `stepUp` does. It needs a session, so it rejects with
  `AuthSessionEndedError` rather than opening a prompt with no token, and it
  settles through the passkey refusals: `rejected`, `unavailable`,
  `rate-limited`, `cancelled`, `unsupported` and `no-passkeys`. The last means
  the account has no passkey enrolled; offer `stepUp` with a code instead.

Refusal reasons: `invalid-code`, `already-enabled`, `no-pending-enrolment`,
`rate-limited`, `unavailable`. These return outcomes rather than throwing, and
reject only for a network failure, a 500, or a 401 the client could not repair.

`paths`: `totpEnrol`, `totpActivate`, `totpDisable`, `recoveryCodes`, `stepUp`,
`stepUpPasskeyOptions`.

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
- **`unsupported` does not either.** The support probes are advisory: a browser
  can accept `conditionalMediationAvailable()` and then reject the request with
  a `NotSupportedError`, which headless Chromium does for a discoverable
  credential. That name, and every browser-side rejection of a
  `mediation: 'conditional'` ceremony, comes back as `unsupported` with
  `state.error` left null, so an autofill sign-in armed on mount needs no
  `.catch` and raises no unhandled rejection. Hide the control rather than
  render it. `isPasskeyUnsupported` recognises the name on its own.

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
`passkeyLoginOptions`, `passkeyLoginVerify`, `passkeys`,
`stepUpPasskeyOptions`.

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

## The identity client singleton

`@webbpulse/auth/browser` builds the lazy singleton every product wraps around
`createAuthClient`, so an application's `identityClient` module is a
configuration call plus its own re-exports rather than eighty copied lines.

```ts
import { createIdentityClientSingleton } from '@webbpulse/auth/browser';

const identity = createIdentityClientSingleton<UserRead>({
  apiBaseUrl: () => appConfig.apiBaseUrl,
});

export const getIdentityClient = identity.getClient;
export const identityOrigin = identity.identityOrigin;
export const identityUrl = identity.identityUrl;
export const CURRENT_USER_PATH = identity.currentUserPath;
export const setWebAuthnAdapterForTests = identity.setWebAuthnAdapterForTests;
export const resetIdentityClientForTests = identity.resetForTests;
```

- **The client is built on the first `getClient()`**, not at import time, so a
  module importing it does not construct a network capable object to be
  imported. The result is cached, a null included.
- **Pass `apiBaseUrl` as a thunk** when a test restubs the environment between
  cases: it is read at each build rather than once at module load, so
  `resetForTests()` then `getClient()` picks up the new value. A constant is
  fine when nothing restubs.
- **An origin that reduces to the empty string falls back to
  `location.origin`**, which is what a root relative base behind a dev proxy
  wants. `relativeAs: 'passthrough'` keeps the base instead, for a deployment
  whose identity routes are not at the root.
- **`credentials: 'include'` and a 30 second timeout** are the defaults, since
  the refresh cookie needs the first and every product chose the second.
- **`currentUserPath` defaults to `/api/users/me`** and carries the `/api`
  prefix, because the origin is stripped back to a bare one. The default
  `loadUser` reads it and unwraps `response.data ?? null`.
- **`setWebAuthnAdapterForTests` must run before the first `getClient()`**,
  since `AuthClient` fixes the adapter at construction. `resetForTests` disposes
  the cached client and clears the seam.

`identityOriginFrom` and `identityUrl` are exported from this entry too, the
same functions `@webbpulse/discovery` exports. They are carried here rather than
imported, because discovery already depends on this package and the reverse edge
would be a cycle.

## Settings panels

`@webbpulse/auth/panels` holds the state machines the identity settings pages
run, with no rendering: a product keeps its own markup, copy and layout and
destructures the state and the handlers.

```tsx
import { usePasskeyPanel } from '@webbpulse/auth/panels';

const panel = usePasskeyPanel({
  client: auth,
  messages: { removed: 'Passkey removed.' },
});

if (panel.unavailable) return null;
return panel.items?.map((key) => (
  <Row
    key={key.credentialId}
    passkey={key}
    onDelete={() => void panel.remove(key.credentialId)}
  />
));
```

Each hook loads on mount, sets `busy` for the duration of a call, records the
server's own sentence in `error` and reloads the collection after a success.
Success copy is the product's, passed as `messages`; refusal copy is always the
server's and is rendered verbatim.

`useConnectedAccountsPanel` takes the deployment's provider list, offers
`connectable` for the ones not yet attached, and leaves `busy` true through a
successful `link`, which navigates to the provider. `useTotpPanel` has no load
leg, because no route reports whether a factor is on: pass `factor` when the
user record says.

`useListPanel` is the core the three are built from, exported so a product can
apply the same shape to a collection this package does not model.

## Sign-in helpers

`usePasskeySignInSupport` answers whether to draw a passkey button and whether
to arm conditional mediation, asking the browser only after the deployment says
passwordless is on. Pass `@webbpulse/discovery`'s `passkeyLoginAvailability` as
the probe.

`usePasskeySignInButton` is the whole button above it, headless: the support
gate, the conditional ceremony and the click handler in one, returning state and
handlers only so a product keeps its own markup and copy.

```tsx
const button = usePasskeySignInButton({
  client: getIdentityClient(),
  probe: () => passkeyLoginAvailability(identityUrl(PASSKEY_AVAILABILITY_PATH)),
  email,
  onResult: (result) => {
    if (result.ok && result.kind === 'mfa-required') setTicket(result.ticket);
  },
});

if (!button.offered) return null;
return (
  <Button onClick={() => void button.signIn()} disabled={button.busy}>
    {button.busy ? 'Waiting for your passkey' : 'Sign in with a passkey'}
  </Button>
);
```

- **Conditional mediation is armed in an effect and torn down on cleanup**
  through an `AbortController`, so a ceremony does not outlive the page. A
  result arriving after the abort is dropped, since a torn-down ceremony reports
  a cancellation nobody asked for.
- **`onResult` is read through a ref**, so a handler redefined on every render
  does not restart the ceremony, and it need not be memoised. `probe` is read
  the same way.
- **A cancellation is silent** on both paths: a dismissed prompt is not a
  failure to render. Every other outcome, refusals included, reaches `onResult`.
- **A thrown ceremony goes to `onError`**, which the client reserves for a
  network failure or a server error it could not turn into an outcome. Without
  `onError`, `signIn` rejects with that error, so pass one from a click handler
  that does not await the promise, or it surfaces as an unhandled rejection.
- **`offered` is false without a client**, so a deployment that could not build
  one draws nothing rather than a button that cannot work.

`useOAuthProviderLinks` turns the deployment's provider list into one link each,
with the start URL already built. Anchors, because the start route redirects to
a host that sends no CORS headers, so it must be a real navigation.

```tsx
const providers = useOAuthProviders({ identityOrigin: identityOrigin() });
const links = useOAuthProviderLinks({ client, providers, returnTo });

return links.map((link) => (
  <a key={link.id} href={link.href}>
    <ProviderIcon provider={link.id} />
    <span>Continue with {link.displayName}</span>
  </a>
));
```

An empty array is the one signal to render nothing: no client and no providers
both reduce to it. The result is memoised on the client, the list and
`returnTo`, so it is stable across an unrelated re-render.

`useEmailVerificationLink` spends a mailed verification token exactly once on
mount and reports `confirming`, `confirmed`, `missing-token`, `refused` or
`failed`, leaving every sentence to the caller. A ref guards the single-use
token against the double mount StrictMode performs in development.

## A notice dismissed until the next sign-in

`useDismissedUntilSignIn(key)` in `@webbpulse/auth/react` is the state behind a
dismissible notice, such as an "in development" banner, that should greet every
new session without returning on each page load inside one. It returns
`{ dismissed, dismiss }` and draws nothing, so each application keeps its own
markup.

```tsx
const { dismissed, dismiss } = useDismissedUntilSignIn('dev-banner');
if (dismissed) return null;
return <Banner onClose={dismiss} />;
```

- The flag lives in `sessionStorage` under `DISMISSAL_STORAGE_PREFIX` plus the
  key, so it is per tab: a reload keeps it and a new tab starts without it.
- It records whether it was made signed in or signed out, and lapses when the
  session settles on the other side. One made in a session lapses on the
  sign-out or expiry that ends it, including one found on the first settle of a
  page load, so the next sign-in shows the notice again. One made while signed
  out sticks across reloads and lapses on the next sign-in.
- Nothing lapses while the session is still unknown or during a token refresh
  on a live session, and the lapse is derived during render, so the notice never
  flashes.
- Storage that throws, as in a privacy mode or a sandboxed frame, falls back to
  memory for the page's lifetime.

## Polled queries

`useQueryAuth` is the `auth` option `usePolledQuery` takes, bound to the client
already in context:

```ts
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';

const auth = useQueryAuth();
const { data } = usePolledQuery(({ signal }) => listJobs(signal), {
  queryKey: 'jobs',
  auth,
});
```

Without it each application writes the same adapter by hand, and the one that
forgets ships a query that mounts during boot, goes out anonymous and renders a 401. The result is referentially stable for the client's lifetime, so passing it
straight into the options does not restart the poll on every render.

The hook lives here rather than in `@webbpulse/api-client` because the bridge
needs the auth client, and the client package stays free of a dependency on this
one. `usePolledQuery` keeps taking a plain `{ waitForToken }`, so a caller
outside the provider is unaffected.

## `SessionManager`

Deprecated, and removed in the next major. Not the identity standard's
mechanism: it survives for the plain session cookie Portfolio's admin panel uses
today, and it is cookie only. Constructing one warns. New code should use
`AuthClient`, which models the same session plus passkeys, OAuth, TOTP and the
email flows, and reports refusals as outcomes rather than throwing.

## Exports

`@webbpulse/auth`

- Client: `AuthClient`, `createAuthClient`, and the deprecated
  `SessionManager`.
- Errors: `AUTH_ERROR_CODES`, `AuthSessionEndedError`, `getAuthErrorCode`,
  `isAuthErrorCode`, `describeAuthError`.
- Link flows: `VERIFY_EMAIL_PATH`, `RESET_PASSWORD_PATH`, `LINK_TOKEN_PARAM`,
  `readLinkToken`, `retryAfterSeconds`, `classifyLinkError`.
- MFA: `TOTP_FACTOR`, `classifyMfaError`.
- OAuth: `GOOGLE_PROVIDER`, `GITHUB_PROVIDER`, `readOAuthCallback`,
  `stripOAuthParams`, `parseOAuthLinks`, `describeOAuthCallbackError`,
  `classifyOAuthError`, and the `OAUTH_*` parameter constants.
- Passkeys: `passkeysSupported`, `conditionalMediationAvailable`,
  `isPasskeyCancellation`, `isPasskeyUnsupported`, `toCreationOptions`,
  `toRequestOptions`,
  `credentialToJSON`, `base64UrlToBuffer`, `bufferToBase64Url`, `parsePasskey`,
  `parsePasskeys`, `parsePasskeyChallenge`, `classifyPasskeyError`.

Types accompany each group, including `AuthClientOptions`, `AuthState`,
`AuthStatus`, `AuthErrorCode`, `AuthPaths`, `LoginOutcome`, `MfaChallenge`,
`PasswordCredentials`, `WebAuthnAdapter` and the outcome unions for every flow.

`@webbpulse/auth/react`

`AuthProvider`, `useAuth`, `useAuthClient`, `useAuthState`, `useSessionEnded`,
`useOAuthCallback`, `usePasskeySignInSupport`, `usePasskeySignInButton`,
`useOAuthProviderLinks`, `useEmailVerificationLink`, `useQueryAuth`,
`useDismissedUntilSignIn`, `DISMISSAL_STORAGE_PREFIX`, and the
deprecated `SessionProvider`, `useSession`, `useSessionState`,
`useSessionManager`, with `AuthProviderProps`, `UseAuthResult`, `AnyAuthClient`,
`PasskeySignInSupport`, `PasskeySignInSupportOptions`, `PasskeySignInButton`,
`PasskeySignInButtonOptions`, `OAuthProviderLink`, `OAuthProviderLinksOptions`,
`EmailVerificationLinkState`, `EmailVerificationLinkOptions`, `QueryAuth`,
`DismissedUntilSignIn`,
`SessionProviderProps`, `UseSessionResult`, `AnySessionManager` and
`OAuthCallbackHandler`.

`@webbpulse/auth/browser`

`createIdentityClientSingleton`, `identityOriginFrom`, `identityUrl` and
`DEFAULT_CURRENT_USER_PATH`, with `IdentityClientSingleton`,
`IdentityClientSingletonOptions`, `RelativeOriginMode` and `ConfigValue`.

`@webbpulse/auth/panels`

`usePasskeyPanel`, `useConnectedAccountsPanel`, `useTotpPanel`, `useListPanel`,
`PANEL_OK` and `PANEL_CANCELLED`, with `ListPanel`, `PanelState`,
`PanelOutcome`, `PanelMessages`, `ListPanelConfig`, `PasskeyPanel`,
`ConnectedAccountsPanel`, `ProviderOption`, `TotpPanel`, `TotpStep`,
`TotpPrompt`, `FactorState` and the options and messages types for each.
