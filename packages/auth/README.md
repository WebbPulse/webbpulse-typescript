# @webbpulse/auth

The frontend half of the WebbPulse unified identity standard, sections 7.1, 7.2
and 7.3. Framework free, with the React bindings in a separate entry so an
application importing only the core never pulls React into its bundle.

```ts
import { createAuthClient } from '@webbpulse/auth';
import { createApiClient } from '@webbpulse/api-client';

const auth = createAuthClient<UserRead>({
  baseUrl: config.apiBaseUrl,
  loadUser: (client) => client.get<UserRead>('/users/me').then((r) => r.data),
  onSessionEnded: () => {
    router.navigate('/login');
  },
});

// Every other request in the application goes through this client, which reads
// the access token off `auth` and retries once through it on a 401.
const client = createApiClient({ baseUrl: config.apiBaseUrl, auth });
```

```tsx
import { AuthProvider, useAuth } from '@webbpulse/auth/react';

<AuthProvider
  client={auth}
  onSessionEnded={() => {
    navigate('/login');
  }}
>
  <App />
</AuthProvider>;

const { status, user, isAuthenticated, login, logout } = useAuth<UserRead>();
```

## The shape of the thing

- **The access token lives in a private field and nowhere else.** Not
  `localStorage`, not `sessionStorage`, not a cookie the page can read, not a
  module level variable another module can reach. An XSS that can run code can
  always read a token out of the running heap, but it cannot read one out of a
  tab it never compromised, and it cannot exfiltrate one that survives a reload.
  A test asserts that a full login, refresh and logout cycle touches no storage
  API at all.
- **The refresh token is an httpOnly cookie the page cannot see.** Every call
  the client makes sets `credentials: 'include'`, which is the only way the
  browser attaches `wp_refresh` on a cross origin request (5.5). The cookie's
  `Path=/api/auth` means it never rides along on ordinary API calls.
- **One refresh is in flight at a time.** Ten components mounting at once, or
  ten requests taking a 401 together, produce exactly one call to
  `/api/auth/refresh`. This is not an optimisation. The server rotates the
  refresh token and treats a second presentation of a consumed one as reuse, so
  a second concurrent rotation would revoke the whole family and sign the user
  out of a session that was perfectly healthy (2.6).
- **The startup refresh distinguishes "signed out" from "session ended".** A
  first time visitor with no cookie gets `status: 'anonymous'`, a null
  `sessionEnded` and no `onSessionEnded` call, because bouncing someone to a
  login screen they never left is wrong. A refresh that fails mid session sets
  the field and calls the hook.
- **The proactive refresh fires at 80% of `expires_in`**, so a ten minute token
  is replaced at eight minutes and the reactive 401 path is the fallback rather
  than the norm. Set `proactiveRefreshRatio` to move it, or
  `disableProactiveRefresh` in a test or under server side rendering, where a
  dangling timer keeps the process alive.
- **`status` is one field**, one of `unknown`, `loading`, `authenticated` and
  `anonymous`, rather than separate `isAuthenticated` and `isLoading` booleans
  that together can express states meaning nothing. The distinct `unknown` is
  what prevents a frame of signed out UI on first paint.

## What a route guard gates on

`status` moves to `'loading'` for the duration of every session call, a login, a
TOTP completion, a step-up, a logout and a refresh alike. A guard that treats
that as "the session is not known yet" unmounts whatever is driving the call, and
a login form unmounted mid-request loses the MFA challenge that was about to
arrive. The hooks therefore hand a guard flags that already account for this, and
a guard should read those rather than `status`:

| Flag              | Means                                                                                                               | Gate this on it                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `isLoading`       | The session has never settled. Latches false on the first `authenticated` or `anonymous` and never returns to true. | The first-paint spinner, and nothing else. |
| `isBusy`          | A session call is in flight, settled or not.                                                                        | A button spinner, a disabled form.         |
| `isAuthenticated` | A session is held. Stays true through a call made on an already authenticated session.                              | A redirect.                                |

The third row is the subtle one. `isAuthenticated` is not a bare
`status === 'authenticated'`: an in-flight call on a live session would read as
signed out for its duration, and a guard redirecting on `!isAuthenticated` would
eject a signed in user on every later token call. `useAuth` keeps it true while a
call is in flight and the access token is still held; `useSession` does the same
while the manager already had a user.

So a guard is two lines, with no local latch of its own:

```tsx
const { isAuthenticated, isLoading } = useAuth<UserRead>();

if (isLoading) return <Spinner />;
if (!isAuthenticated) return <Navigate to="/login" replace />;
return <Outlet />;
```

## Reading and writing the user without spending a rotation

`loadUser` runs on a login and on a successful refresh, which leaves a gap: an
application that changes something the profile reflects has no way to get the
fresher copy into the store. Calling `refresh` would work and is the wrong call,
because it rotates the refresh token to learn a display name, and every rotation
is a chance for the reuse detector to end a healthy session.

Two methods close it, and neither touches the token or the cookie:

```ts
const updated = await client.patch<UserRead>('/users/me', { name });
auth.setUser(updated.data);

await auth.reloadUser();
```

`setUser(user)` writes a user the caller already has straight into the store, with
no request at all. It leaves `status` alone rather than promoting an anonymous
client to authenticated, since a user object is not a session.

`reloadUser()` re-reads the user through the configured `loadUser` hook and
resolves to it, or to the current user unchanged when no `loadUser` was given. A
401 from that read means the token this client holds is no longer good, so it ends
the session exactly as a failed refresh does, `onSessionEnded` and `sessionEnded`
included, and resolves to null. Any other failure leaves the session alone and
lands in `error`, because a profile route being down is not a reason to sign
someone out.

Both are on `useAuth` in the React entry, bound and stable for the client's
lifetime like the rest.

## Reacting to the session ending from React

`onSessionEnded` on `AuthClientOptions` is a constructor callback, which is the
wrong shape for a component: it is wired before React exists and a component
cannot subscribe to it. The React entry therefore exposes the same ending twice
over, and neither reading goes through `error`.

`AuthState.sessionEnded` carries the `AuthSessionEndedError` for the current
ending, or null. Read it with `useSessionEnded`, or off `useAuth` and
`useAuthState`, which both carry it:

```tsx
import { useSessionEnded } from '@webbpulse/auth/react';

function ExpiryBanner(): ReactNode {
  const sessionEnded = useSessionEnded();
  if (sessionEnded === null) {
    return null;
  }
  return (
    <p role="alert">
      {sessionEnded.reason === 'logged-out'
        ? 'Signed out.'
        : 'Your session expired. Please sign in again.'}
    </p>
  );
}
```

`AuthProvider` also takes an `onSessionEnded` prop, for the side effect a
redirect wants rather than a render:

```tsx
<AuthProvider
  client={auth}
  onSessionEnded={(error) => {
    navigate(error.reason === 'logged-out' ? '/' : '/login?expired=1');
  }}
>
  <App />
</AuthProvider>
```

It fires on top of whatever the client's own `onSessionEnded` option does, so a
product that already wired the constructor hook keeps it. Three things to know:

- **It fires on an ordinary 401 expiry.** This is why `error` cannot stand in:
  `error` stays null on a 401 refusal, which is exactly the expiry case, because
  an expired session is not a failure a form should render. `sessionEnded` is set
  whatever the status code, and a non-401 failure sets both.
- **Exactly once per ending.** A ref holds the last error the handler was given,
  so StrictMode's double mount and every later re-render replay nothing, and the
  next distinct ending fires again. The ref also holds the latest handler, so a
  caller need not memoise it.
- **It does not fire when the startup refresh found no cookie**, and
  `sessionEnded` stays null there, matching the constructor hook. A first time
  visitor gets `status: 'anonymous'` and nothing else; nothing ended.

`sessionEnded` is cleared by the next successful `login` or `initialize`, so a
redirect-on-expiry does not re-fire once the user signs back in. A failed login
leaves it alone, since a wrong password ends nothing.

## Testing a component under the provider

**A stub standing in for the client needs only the methods the test exercises.**
`AuthProvider` calls `initialize` on mount and `useAuthState` calls `getState`
and `subscribe`, so those three are the floor. Everything else on `useAuth` is
bound on first read rather than up front, which means a component that signs the
user out needs `logout` and nothing more:

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

Pass `initializeOnMount={false}` and the `initialize` stub goes too. Every
`UseAuthResult` key is still present and still enumerable, so destructuring and
`Object.keys` read the same as ever; reading a key the stub does not implement is
what throws, with the method name in the message:

```
useAuth: the auth client does not implement renamePasskey(). A test stub needs
only the methods the component under test calls.
```

The stability guarantee is unchanged. Each wrapper is cached against the client
instance the first time it is read, so it is the same function on every later
render and safe in a dependency array, and two different clients never share one.
A real `AuthClient` implements the whole surface, so nothing about production
behaviour changes; this only stops a partial test double failing at render time
over a method the component never calls.

## The refresh never recurses

`/api/auth/refresh` is called with retries disabled, and the 401 retry in
`@webbpulse/api-client` is structurally incapable of looping: `request` calls
`requestOnce` at most twice and has no loop of its own, and the replay carries
`skipAuthRetry`. A stale token therefore costs one extra round trip, never an
infinite one.

## MFA and the second factor

`login` returns a `LoginOutcome`, a discriminated union on `mfaRequired`:

```ts
const outcome = await auth.login({ email, password });
if (outcome.mfaRequired) {
  // outcome.factors, outcome.ticket
  await auth.completeTotp({ ticket: outcome.ticket, code });
}
```

The ticket is held in `state.pendingMfa` as well, so a component that navigated
between the two steps can pick it up from the store rather than threading it
through a router.

The first leg answers **200 with the challenge**, not 401. Nothing was refused:
the password was correct and the flow is half done. That is why `mfaRequired` is
a branch on a successful outcome rather than something to catch.

## Enrolling TOTP, recovery codes and step-up

Five methods for the rest of the identity service's MFA surface, all of them on
routes behind the authorizer, so all of them carry the bearer token from this
client and inherit its refresh-once behaviour on a 401.

```ts
await auth.enrolTotp(); // { secret, provisioningUri }
await auth.activateTotp({ code }); // { recoveryCodes }
await auth.disableTotp({ code }); // { ok: true }
await auth.regenerateRecoveryCodes({ code }); // { recoveryCodes }
await auth.stepUp({ code }); // adopts a fresher access token
```

**Four of the five take a code**, and every `code` above accepts either a
current TOTP code or an unspent recovery code. Disable and regenerate ask for
one because a bearer token on its own is a weaker thing to hold than a bearer
token plus a live factor, and those two either remove the second factor or void
the printout that survives losing the phone. Both answer a wrong code with the
same `invalid-code` refusal an activation does.

**They return outcomes rather than throwing**, in the style of the link flows
and for a sharper version of the same reason: a user mistyping a six digit code
is the single most likely thing to happen with an activation form open. Putting
that in a `catch` puts the common path in the handler. They reject only for a
network failure, a 500, or a 401 the client could not repair, which is the
session ending rather than a form field error.

### The enrolment sequence

```ts
// 1. Start the enrolment. The factor is written inactive, so it does not gate
//    login yet and a user who scans badly has changed nothing.
const started = await auth.enrolTotp();
if (!started.ok) {
  // 'already-enabled' means disable the existing factor first, which is the
  // only path the server offers. 'rate-limited' means wait.
  return setBanner(started.message);
}

// 2. Show the QR code, with the seed as the typed fallback. This package
//    renders no QR code and adds no dependency to do it: hand
//    started.provisioningUri to whatever generator the product already has.
showQr(started.provisioningUri);
showTypedFallback(started.secret);

// 3. Activate with the first code from the authenticator. Only now does the
//    factor count, and only now do recovery codes exist.
const activated = await auth.activateTotp({ code });
if (!activated.ok) {
  switch (activated.reason) {
    case 'invalid-code':
      return setFieldError('code', activated.message);
    case 'no-pending-enrolment':
      // A stale form: reloaded, or activated in another tab. Start again.
      return restartEnrolment();
    case 'rate-limited':
      return setBanner('Too many attempts. Try again shortly.');
    case 'unavailable':
      return setBanner('Two factor sign in is unavailable right now.');
  }
}

// 4. Show the recovery codes, once, and say so. The server stores only their
//    hashes and cannot show them again.
showRecoveryCodesOnce(activated.recoveryCodes);
```

Replacing that set later, or turning the factor off, runs the same code check
the activation did:

```ts
const fresh = await auth.regenerateRecoveryCodes({ code });
if (fresh.ok) {
  showRecoveryCodesOnce(fresh.recoveryCodes); // the old set is already dead
} else if (fresh.reason === 'invalid-code') {
  setFieldError('code', fresh.message);
}
```

**Both secrets are shown exactly once.** There is no route that reads a seed
back, so a user who loses it before activating calls `enrolTotp` again and gets
a new one. The recovery codes come back from the activation that created them,
and the only way to see a set again is `regenerateRecoveryCodes`, which replaces
every code and invalidates the printout the user was trying to recover. A screen
that renders either without saying it will not be shown again is setting up a
support ticket.

### Step-up

`stepUp` is not a second login. No refresh family is started and the refresh
cookie is untouched, because the session is not new: the user is proving
freshness inside it. What changes on the new token is `auth_time`, which becomes
now, and `amr`, which gains the factor just satisfied. A sensitive route asserts
on those two rather than on a boolean, which is what makes "was this
re-authenticated recently" answerable at all.

The new token is adopted into this client's in-memory store and the proactive
refresh timer is re-armed against it, so the next request carries it with no
further work at the call site. It is not in the outcome, because there is
exactly one place an access token lives.

```ts
const stepped = await auth.stepUp({ code });
if (stepped.ok) {
  await deleteTheAccount(); // the token now carries a fresh auth_time
}
```

`code` takes a TOTP code or a recovery code, on this route and on the other
three that verify one. The server tells them apart by shape, so a caller does
not choose and cannot be made to disclose which kind the user had.

### One refusal, on purpose

`invalid-code` is a single case covering a wrong code, a replayed code, no
factor enrolled, a factor enrolled but not activated, a spent recovery code and
a recovery code that never existed. The server answers all six with one message
so the second leg of login cannot be used to discover which accounts have TOTP
enabled. A client that split them would be inventing information it does not
have. Render `outcome.message`, which is the server's own sentence.

Route paths are overridable through `paths`: `totpEnrol`, `totpActivate`,
`totpDisable`, `recoveryCodes`, `stepUp`.

## Email verification and password reset

Four methods, one for each of the identity service's link routes. Section 2.6
calls verification and reset one primitive, "a single-use, time-limited, signed
link", and these keep that symmetry: the two flows differ only in which pair of
routes they call and which page the mailed link lands on.

```ts
// Anonymous. Works on a signed out page, which is the point: a user who never
// finished signing up has no session, and the resend has to work for them.
await auth.requestEmailVerification({ email });
await auth.requestPasswordReset({ email });

// Called by the landing pages the mailed links point at.
await auth.confirmEmailVerification({ token });
await auth.confirmPasswordReset({ token, newPassword });
```

**These four return outcomes rather than throwing.** Every other method on the
client rejects on failure, which is right for a login: there is no result to
hand back. These are different, because their likely non-success is not an
exception but an answer a form has to render next to a field, such as "this link
has expired" or "that password is too short". So they resolve to a discriminated
union in the same style as `LoginOutcome`, and reject only for a network failure
or a 500, which is what a caller genuinely could not have anticipated.

```ts
const outcome = await auth.confirmPasswordReset({ token, newPassword });
if (outcome.ok) {
  router.navigate('/login');
} else {
  switch (outcome.reason) {
    case 'invalid-link':
      setBanner('This link is no longer valid. Request a new one.');
      break;
    case 'password-rejected':
      // The link is spent as well, so this needs a new link and a new password.
      setFieldError('password', outcome.message);
      break;
    case 'rate-limited':
      setBanner('Too many attempts. Try again shortly.');
      break;
    case 'unavailable':
      setBanner('Password reset is unavailable right now.');
      break;
  }
}
```

### Reading the token off the landing page

The links are mailed as `<frontend_base_url>/verify-email?token=…` and
`<frontend_base_url>/reset-password?token=…`, so the token is in the address bar
and nowhere else by the time a component mounts. `VERIFY_EMAIL_PATH` and
`RESET_PASSWORD_PATH` are those two SPA paths, and they must equal
`VERIFY_LINK_PATH` and `RESET_LINK_PATH` in the backend's
`webbpulse.identity.verification`, which is what builds the URL. Nothing enforces
that across the two repositories at build time, so both sides carry a test
asserting the literal.

```ts
import { readLinkToken, RESET_PASSWORD_PATH } from '@webbpulse/auth';

const token = readLinkToken({ expectedPath: RESET_PASSWORD_PATH });
if (token === null) {
  setBanner('This link is missing its token. Request a new one.');
}
```

`expectedPath` is optional and worth passing. A single page handling both links
would otherwise read the verification token while sitting on the reset page and
present it to the wrong endpoint, which the backend refuses as a wrong-purpose
token.

`RESET_PASSWORD_PATH` is the SPA page, not the API route. The API confirms a
reset at `/api/auth/reset/confirm`; the page is what collects the new password
and calls it. That indirection is deliberate on the backend's side: a `GET` that
consumed the token would be spent by the first mail scanner that follows the
link to check it for malware, before the user ever clicked.

### Two things the request side deliberately does not tell you

**Whether the address exists.** Section 5.4 puts both request routes in the
enumeration-resistance table: an unknown address, an already verified one and one
that just got a link all answer 200 with the same body. `EmailRequestOutcome` has
no `sent: false` because there is no second case to model, and a caller must not
try to infer one. Render "if that address has an account, a link is on its way"
and nothing more specific. The reset route returns that exact sentence in
`detail`, so prefer showing the server's copy over writing a local one.

**Anything about a successful reset except that it happened.** A reset revokes
every refresh family for the account, this browser's included, so
`confirmPasswordReset` drops the client's own token on success. The user signs in
again with the new password, which is the intended end of the flow. It does not
fire `onSessionEnded`, because the caller is standing on the reset page and its
own success branch navigates.

Route paths are overridable through `paths`, alongside the rest:
`verifyEmail`, `verifyEmailConfirm`, `passwordReset`, `passwordResetConfirm`.

## Signing in with a provider

Google and GitHub, against the identity service's five OAuth routes. Two of them
are browser navigations rather than API calls, which is why the client's surface
is not five methods of the same shape.

### Sending the user to the provider

`oauthStartUrl(provider, options?)` builds the URL. It is a builder rather than
a call because `GET /oauth/{provider}/start` answers `302` to the provider, and
a cross-origin redirect cannot be followed by script: there is nothing for a
`fetch` to read. Put it in an `href`, which is the form a "Sign in with Google"
button actually wants, since a real link is middle-clickable and is announced as
a link:

```tsx
<a href={auth.oauthStartUrl('google', { returnTo: '/dashboard' })}>
  Sign in with Google
</a>
```

`startOAuth(provider, options?)` is the same URL plus the navigation, for a
caller driving the flow from a button. It is synchronous and returns void,
because the page is leaving.

### How the session comes back

The callback runs on the API, not in the SPA, and it finishes by redirecting the
browser to the frontend. **There is no one-time code to exchange.** The server
sets the ordinary refresh cookie on that redirect, through the same writer the
password login uses, so the two paths cannot drift apart on cookie attributes.
What lands on the frontend is one query parameter saying which of four things
happened:

| Parameter             | Meaning                         | What to do                            |
| --------------------- | ------------------------------- | ------------------------------------- |
| `?oauth=1`            | signed in, refresh cookie set   | `await auth.initialize()`             |
| `?mfa_ticket=<t>`     | the account has a second factor | `auth.completeTotp({ ticket, code })` |
| `?oauth_linked=1`     | a provider was attached         | reload the links list                 |
| `?oauth_error=<CODE>` | refused, or the user cancelled  | render the code                       |

`readOAuthCallback(href)` reads whichever is present and narrows it to a
discriminated union, so a landing page is a `switch` rather than four
`searchParams.get` calls and a guess at precedence:

```ts
const result = readOAuthCallback(window.location.href);
switch (result?.kind) {
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
history.replaceState(null, '', stripOAuthParams(window.location.href));
```

`null` means the page was not reached from a callback, which is every direct
visit and every reload after the parameters were cleared. The precedence when
more than one is present is fixed: an error first, then a ticket, then a link,
then a sign-in. A `returnTo` that already carried its own `?oauth=1` would
otherwise let a stale parameter outrank a live refusal, and reporting a failed
sign-in as a successful one is the wrong way round to be wrong.

**The access token is never in the URL.** It arrives the way it always does:
`initialize()` spends the refresh cookie and holds the token in memory. A token
in a query string is in the browser history, in the `Referer` of the next
request, and in whatever proxy logged the navigation.

**The MFA ticket is in the URL, and that is a considered trade.** The browser is
mid-navigation, so the challenge cannot come back as a JSON body the way the
password path's does: the frontend has to render a code prompt. The ticket is
short-lived and single use for exactly that reason. Call `stripOAuthParams` and
`history.replaceState` as soon as it is read, which is what the last line above
does.

### Linking and unlinking from a settings page

Three ordinary JSON routes behind the authorizer, all carrying the bearer token
from this client. Each takes its subject from the verified claims, never from
anything in a body, so a caller cannot touch an account that is not their own.

```ts
const { links } = await auth.listOAuthLinks();
// [{ provider: 'google', email, emailVerified, linkedAt, lastLoginAt }]

const started = await auth.linkOAuthProvider('github', {
  returnTo: '/settings/security',
});
if (started.ok) {
  window.location.assign(started.authorizationUrl);
}

const removed = await auth.unlinkOAuthProvider('github');
if (!removed.ok && removed.reason === 'last-sign-in-method') {
  setBanner(removed.message);
}
```

`linkOAuthProvider` answers with a URL rather than redirecting, and the
difference from the start route is the whole reason the route exists: it is
called over `fetch` with an `Authorization` header, and a redirect would be
followed by `fetch` without that header and land somewhere useless.

The list carries no provider subject. It is the provider's stable id for the
user, it is of no use to a settings page, and echoing an identifier from another
system into a response body is how it ends up in a log or a bug report.

`unlinkOAuthProvider` refuses to leave an account with no way in, and
`last-sign-in-method` is the one refusal in this package whose remedy is a
specific instruction: set a password first, then unlink. That is why it is a
named outcome rather than a thrown 409, and why the server's own sentence is the
one to render. The server counts other provider links, a password credential,
and whatever the product's own hook reports, which is where passkeys are
counted.

### Which refusals are outcomes

The same rule the link and MFA flows follow. `already-linked`, `not-linked`,
`last-sign-in-method`, `provider-unavailable` and `rate-limited` are outcomes,
each modelled only on the route that can legitimately produce it, so an
`OAUTH_ALREADY_LINKED` arriving from the unlink route throws rather than
becoming a silent success. A network failure, a 500, and a 401 the transport
could not repair all throw: the last of those is the session ending, not a
settings page error state.

`rate-limited` carries `retryAfter` in seconds, read from the `Retry-After`
header that `@webbpulse/api-client` keeps on `ApiError` as of 0.7.0 and falling
back to a `retry_after` in the envelope's `details`. Section 5.1 puts the start
route at 20 per 15 minutes per IP.

Route paths are overridable through `paths`: `oauthStart`, which defaults to
`/api/auth/oauth` and has the provider and `/start` or `/link` appended, and
`oauthLinks`, which defaults to `/api/auth/oauth/links`.

## Signing in with a passkey

Seven routes on the server, and unlike the OAuth set every one of them is an
ordinary `fetch`. What is different here is that each ceremony is **two round
trips with a browser API in between**: fetch options, run
`navigator.credentials`, post what it returned. `registerPasskey` and
`signInWithPasskey` each run both legs, because the challenge between them is a
single-use row on the server that is spent by one attempt whatever the outcome.
Holding the options across a user interaction is how a ceremony ends up half
finished with the row already consumed, so a failed attempt starts again from
the options leg, which is what calling the method again does.

Check support before rendering a button, because a button that throws when it is
pressed is worse than no button:

```ts
import {
  passkeysSupported,
  conditionalMediationAvailable,
} from '@webbpulse/auth';

if (passkeysSupported()) {
  // Render the passkey controls.
}
```

`passkeysSupported()` is `window.PublicKeyCredential` being present, which is
what the specification says is true exactly when the API is. It is false in
Node, in a test run with no DOM, and over plain HTTP, since WebAuthn is a
secure-context API. `conditionalMediationAvailable()` is a separate capability
and a separate question: it is what puts a passkey in the same autofill dropdown
as a saved username, and a browser can have one without the other.

### Enrolling

```ts
const outcome = await auth.registerPasskey({ name: 'MacBook Touch ID' });
if (outcome.ok) {
  setPasskeys((current) => [...current, outcome.passkey]);
} else if (outcome.reason !== 'cancelled') {
  setBanner(outcome.message);
}
```

Both legs are authorized routes, so both carry the bearer token and the method
rejects with `AuthSessionEndedError` rather than opening a prompt when no
session is held. `name` is the label the settings page will show; the server
trims it, caps it at 64 characters and substitutes `Passkey` when it is empty,
so omitting it is fine.

### Signing in

```ts
const outcome = await auth.signInWithPasskey();
if (!outcome.ok) {
  if (outcome.reason !== 'cancelled') setBanner(outcome.message);
} else if (outcome.kind === 'mfa-required') {
  setPendingTicket(outcome.ticket);
} else {
  navigate('/');
}
```

Omit `email` for the ordinary discoverable flow: the server answers with no
`allowCredentials` and the authenticator offers whatever it holds for the
relying party. Pass one when the form already collected an address, which
produces an `allowCredentials` list so the browser prompts for the right
credential. **An unknown address is not an error and is not distinguishable from
a known one**: the server answers any address with a challenge and an empty
list, byte-identical to a genuine discoverable request, so this route cannot be
used to find out which addresses have accounts.

A sign-in resolves to `kind: 'mfa-required'` when the authenticator reported no
user verification and the account has TOTP enrolled. Finish it with
`completeTotp({ ticket, code })`, the same method and the same route the
password path uses, because it is the same ticket. A passkey that verified the
user is two factors in one gesture and signs in outright: the assertion proves
possession of a key that never leaves the authenticator, and the `uv` flag
proves the authenticator separately checked something the user knows or is.

For an autofill sign-in, check conditional mediation first and pass an
`AbortSignal` so the pending ceremony can be torn down if the user submits a
password instead:

```ts
if (await conditionalMediationAvailable()) {
  void auth.signInWithPasskey({
    mediation: 'conditional',
    signal: controller.signal,
  });
}
```

### Managing them

```ts
const listed = await auth.listPasskeys();
await auth.renamePasskey(credentialId, 'Work key');
const removed = await auth.deletePasskey(credentialId);
if (!removed.ok && removed.reason === 'last-credential') {
  setBanner('Set a password before removing your last passkey.');
}
```

`listPasskeys` returns the credential id, the label, two timestamps, the
transports the authenticator reported, its `aaguid`, the two backup flags and
whether the user was verified at enrolment. The public key is deliberately not
in the response: it discloses nothing, being public, but a settings page has no
use for it and a body carrying key material invites somebody to start comparing
it to something.

### Which refusals are outcomes

The same rule again, and one of them is the reason this rule exists.
`last-credential` is a delete that would leave an account with no password and
no passkey, and its remedy is a specific instruction, "set a password first",
which no generic failure toast knows to say. It applies only to the last one;
with two enrolled, either can go.

`rejected` is one outcome rather than five, because the server answers one code
for five reasons on purpose: a challenge that does not exist, one that expired,
one minted for another account, an assertion that does not verify and a
credential the server does not know are indistinguishable to a caller, so
neither login route becomes an oracle for which credentials or accounts exist.
`already-registered` is one answer whether the authenticator is enrolled on this
account or somebody else's, for the same reason.

`unavailable` covers both `PASSKEYS_DISABLED` and `PASSKEY_LOGIN_DISABLED`: the
capability is off altogether, or passwordless sign-in specifically is off while
enrolment still works. Both are deployment configuration rather than user error,
and a page should hide the affected control rather than render a failure.
`code` tells the two apart when a caller cares.

`cancelled` is the one that does not come from the server at all. A user who
dismisses the browser's prompt gets a `DOMException` from
`navigator.credentials`, and that is the same gesture as pressing Cancel on an
OAuth consent screen: not an error, and not something to render as one.
`isPasskeyCancellation` recognises it by `name`, and both ceremony methods turn
it into this outcome.

`rate-limited` carries `retryAfter` in seconds, read from `Retry-After` first.
Section 5.1 puts each login leg at 30 per 15 minutes per IP and enrolment at 10
per hour.

### base64url, in both directions

WebAuthn's JavaScript API speaks `ArrayBuffer` and the wire speaks base64url, so
something has to convert. Recent browsers do it themselves through
`PublicKeyCredential.parseCreationOptionsFromJSON`,
`parseRequestOptionsFromJSON` and the credential's own `toJSON`, and those are
used whenever they exist, because they will keep pace with fields added after
this version was written. `toCreationOptions`, `toRequestOptions` and
`credentialToJSON` are the fallback, and they convert exactly the fields the
specification declares as `BufferSource`: everything else is copied through, so
an option this version has never heard of still reaches the browser.

The wire shapes are py_webauthn's `PublicKeyCredentialCreationOptionsJSON` and
`PublicKeyCredentialRequestOptionsJSON` going in, and its
`RegistrationResponseJSON` and `AuthenticationResponseJSON` coming back.

`navigator.credentials` is injected through the `webAuthn` option, so a test can
supply a stub without constructing a real credential. The adapter receives the
whole `CredentialCreationOptions` wrapper rather than the bare `publicKey`
document, because a conditional sign-in also needs `mediation` and `signal` in
that wrapper and there is nowhere else to put them.

Route paths are overridable through `paths`: `passkeyRegisterOptions`,
`passkeyRegisterVerify`, `passkeyLoginOptions`, `passkeyLoginVerify`, and
`passkeys`, which defaults to `/api/auth/passkeys` and is both the list
collection and the base the rename and the delete append a credential id to.

## Errors

`AUTH_ERROR_CODES` opens with exactly the twelve codes section 7.3 names, then
the five the M3 link routes emit: `INVALID_LINK`, `PASSWORD_TOO_SHORT`,
`PASSWORD_REJECTED`, `TOO_MANY_ATTEMPTS` and `EMAIL_NOT_CONFIGURED`, then the
six the M4 MFA routes emit: `INVALID_MFA_CODE`, `MFA_TICKET_INVALID`,
`TOTP_ALREADY_ENABLED`, `NO_PENDING_ENROLMENT`, `MFA_NOT_CONFIGURED` and
`NOT_AUTHENTICATED`, then the sixteen the M6 OAuth routes emit, led by
the three a settings page branches on by name: `OAUTH_LAST_SIGN_IN_METHOD`,
`OAUTH_ALREADY_LINKED` and `OAUTH_NOT_LINKED`, and finally the nine the M5
passkey routes emit: `PASSKEY_REJECTED`, `PASSKEY_ALREADY_REGISTERED`,
`PASSKEY_NOT_FOUND`, `PASSKEY_NAME_REQUIRED`, `PASSKEY_CHALLENGE_INVALID`,
`PASSKEY_LOGIN_DISABLED`, `PASSKEYS_DISABLED`, `LAST_CREDENTIAL` and
`CREDENTIAL_REQUIRED`. Note that `PASSKEY_NOT_RECOGNISED`, in the first twelve,
is 7.3's own code and is a different thing from `PASSKEY_REJECTED`, which is
what the seven routes actually emit for a ceremony that did not verify. The rest
after the first twelve are not in the standard's
list, which was written before those routes existed, and they are added rather
than left to fall through, because `getAuthErrorCode` returning `undefined`
means "not an identity outcome I model" and every one of these is an outcome a
form has to render.

`getAuthErrorCode(error)` returns one of them or `undefined`, and it returns
`undefined` for a code the standard does not name, so a `switch` on the result
falls through to a generic path rather than matching a string nobody promised.

```ts
import { getAuthErrorCode, describeAuthError } from '@webbpulse/auth';

try {
  await auth.login(credentials);
} catch (error) {
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
}
```

`PASSKEY_NOT_RECOGNISED` keeps the standard's British spelling, because it is a
wire value the backend emits and not prose to normalise.

`AuthSessionEndedError` is what `onSessionEnded` receives, and what
`AuthState.sessionEnded` carries. Its `reason` is `'refresh-failed'`,
`'logged-out'` or `'no-session'`, which is enough to decide between a redirect
and a toast.

## `SessionManager`, kept and narrowed

`SessionManager` predates this and is not the identity standard's mechanism. It
survives for the plain session cookie Portfolio's admin panel uses today, and it
is now cookie only: `mode: 'token'`, `tokenStorageKey`, `tokenStorage`,
`extractToken`, `getToken` and `setToken` are gone, along with `TokenStore`,
`MemoryTokenStorage`, `defaultTokenStorage` and `TokenStorage`. See the
CHANGELOG for the migration. New code should use `AuthClient`.

`isLoginComplete` replaces `extractToken` as the hook that says whether a login
response finished the sign in or is waiting on a second factor.

## Exports

Core: `AuthClient`, `createAuthClient`, `AUTH_ERROR_CODES`,
`AuthSessionEndedError`, `getAuthErrorCode`, `isAuthErrorCode`,
`describeAuthError`, `SessionManager`, and the types `AuthClientOptions`,
`AuthState`, `AuthStatus`, `AuthErrorCode`, `AuthPaths`, `AuthSuccess`,
`AuthMfaRequired`, `LoginOutcome`, `MfaChallenge`, `PasswordCredentials`,
`AuthTokenProvider`, `WebAuthnAdapter`, `LoginResult`, `SessionManagerOptions`,
`SessionMode`, `SessionState`, `SessionStatus`.

From the link flows: `VERIFY_EMAIL_PATH`, `RESET_PASSWORD_PATH`,
`LINK_TOKEN_PARAM`, `readLinkToken`, `retryAfterSeconds`, `classifyLinkError`,
and the types `EmailRequestOutcome`, `EmailRequestSent`, `EmailRequestRefused`,
`EmailVerificationOutcome`, `EmailVerificationConfirmed`, `PasswordResetOutcome`,
`PasswordResetConfirmed`, `PasswordResetRejected`, `LinkRefused`, `InvalidLink`,
`RateLimited`, `EmailUnavailable`, `AnyRefusal`, `EmailFlowPaths`.

From the MFA flows: `TOTP_FACTOR`, `classifyMfaError`, and the types
`TotpEnrolmentOutcome`, `TotpEnrolmentStarted`, `TotpActivationOutcome`,
`TotpActivated`, `TotpDisableOutcome`, `TotpDisabled`, `RecoveryCodesOutcome`,
`RecoveryCodesIssued`, `StepUpOutcome`, `StepUpSucceeded`, `MfaRefusal`,
`MfaCodeRejected`, `TotpAlreadyEnabled`, `NoPendingEnrolment`, `MfaRateLimited`,
`MfaUnavailable`, `MfaPaths`.

From the OAuth flows: `GOOGLE_PROVIDER`, `GITHUB_PROVIDER`,
`OAUTH_RESULT_PARAM`, `OAUTH_LINKED_PARAM`, `OAUTH_MFA_TICKET_PARAM`,
`OAUTH_ERROR_PARAM`, `OAUTH_CALLBACK_PARAMS`, `readOAuthCallback`,
`stripOAuthParams`, `describeOAuthCallbackError`, `parseOAuthLinks`,
`classifyOAuthError`, and the types `OAuthCallbackResult`, `OAuthSignedIn`,
`OAuthMfaRequired`, `OAuthLinked`, `OAuthCallbackFailed`, `OAuthLink`,
`OAuthLinkOutcome`, `OAuthLinkStarted`, `OAuthLinksOutcome`, `OAuthLinksLoaded`,
`OAuthUnlinkOutcome`, `OAuthUnlinked`, `OAuthRefusal`, `OAuthLastSignInMethod`,
`OAuthNotLinked`, `OAuthAlreadyLinked`, `OAuthProviderUnavailable`,
`OAuthRateLimited`, `OAuthMode`, `OAuthStartOptions`, `OAuthPaths`.

From the passkey flows: `passkeysSupported`, `conditionalMediationAvailable`,
`isPasskeyCancellation`, `classifyPasskeyError`, `parsePasskey`,
`parsePasskeys`, `parsePasskeyChallenge`, `toCreationOptions`,
`toRequestOptions`, `credentialToJSON`, `base64UrlToBuffer`,
`bufferToBase64Url`, and the types `Passkey`, `PasskeyChallenge`,
`PasskeyRegistrationOutcome`, `PasskeyRegistered`, `PasskeySignInOutcome`,
`PasskeySignedIn`, `PasskeyMfaRequired`, `PasskeyListOutcome`,
`PasskeysLoaded`, `PasskeyRenameOutcome`, `PasskeyRenamed`,
`PasskeyDeleteOutcome`, `PasskeyDeleted`, `PasskeyRefusal`, `PasskeyRejected`,
`PasskeyAlreadyRegistered`, `PasskeyLastCredential`, `PasskeyNotFound`,
`PasskeyNameRequired`, `PasskeysUnavailable`, `PasskeyRateLimited`,
`PasskeyCancelled`, `PasskeyPaths`.

`@webbpulse/auth/react`: `AuthProvider`, `useAuth`, `useAuthState`,
`useAuthClient`, `useSessionEnded`, `useOAuthCallback`, `SessionProvider`,
`useSession`, `useSessionState`, `useSessionManager`, and the types
`AuthProviderProps`, `UseAuthResult`, `AnyAuthClient`, `OAuthCallbackHandler`,
`SessionProviderProps`, `UseSessionResult`, `AnySessionManager`. React is an
optional peer dependency, needed only for this entry point.
