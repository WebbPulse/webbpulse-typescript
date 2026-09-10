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

## Errors

Section 7.3 names twelve error codes, and `AUTH_ERROR_CODES` is exactly that
list. `getAuthErrorCode(error)` returns one of them or `undefined`, and it
returns `undefined` for a code the standard does not name, so a `switch` on the
result falls through to a generic path rather than matching a string nobody
promised.

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

`@webbpulse/auth/react`: `AuthProvider`, `useAuth`, `useAuthState`,
`useAuthClient`, `SessionProvider`, `useSession`, `useSessionState`,
`useSessionManager`, and the types `AuthProviderProps`, `UseAuthResult`,
`AnyAuthClient`, `SessionProviderProps`, `UseSessionResult`,
`AnySessionManager`. React is an optional peer dependency, needed only for this
entry point.
