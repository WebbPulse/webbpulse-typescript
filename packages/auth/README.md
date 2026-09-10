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

<AuthProvider client={auth}>
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
  first time visitor with no cookie gets `status: 'anonymous'` and no
  `onSessionEnded` call, because bouncing someone to a login screen they never
  left is wrong. A refresh that fails mid session calls the hook.
- **The proactive refresh fires at 80% of `expires_in`**, so a ten minute token
  is replaced at eight minutes and the reactive 401 path is the fallback rather
  than the norm. Set `proactiveRefreshRatio` to move it, or
  `disableProactiveRefresh` in a test or under server side rendering, where a
  dangling timer keeps the process alive.
- **`status` is one field**, one of `unknown`, `loading`, `authenticated` and
  `anonymous`, rather than separate `isAuthenticated` and `isLoading` booleans
  that together can express states meaning nothing. The distinct `unknown` is
  what prevents a frame of signed out UI on first paint.

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

## Errors

`AUTH_ERROR_CODES` opens with exactly the twelve codes section 7.3 names, and
appends the five the M3 link routes emit: `INVALID_LINK`, `PASSWORD_TOO_SHORT`,
`PASSWORD_REJECTED`, `TOO_MANY_ATTEMPTS` and `EMAIL_NOT_CONFIGURED`. Those five
are not in the standard's list, which was written before the routes existed, and
they are added rather than left to fall through, because `getAuthErrorCode`
returning `undefined` means "not an identity outcome I model" and every one of
these is an outcome a form has to render.

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

`AuthSessionEndedError` is what `onSessionEnded` receives. Its `reason` is
`'refresh-failed'`, `'logged-out'` or `'no-session'`, which is enough to decide
between a redirect and a toast.

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

`@webbpulse/auth/react`: `AuthProvider`, `useAuth`, `useAuthState`,
`useAuthClient`, `SessionProvider`, `useSession`, `useSessionState`,
`useSessionManager`, and the types `AuthProviderProps`, `UseAuthResult`,
`AnyAuthClient`, `SessionProviderProps`, `UseSessionResult`,
`AnySessionManager`. React is an optional peer dependency, needed only for this
entry point.
