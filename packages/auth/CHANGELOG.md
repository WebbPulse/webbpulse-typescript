# @webbpulse/auth

## 0.4.0

### Minor Changes

- Implement the frontend contract of the unified identity standard, sections 7.1,
  7.2 and 7.3.

  `@webbpulse/auth` gains `AuthClient` and `createAuthClient`. The access token
  lives in one instance field and nowhere else: not `localStorage`, not
  `sessionStorage`, not a cookie the page can read. A reload loses it, and the
  silent refresh on startup repairs it from the httpOnly refresh cookie. Concurrent
  callers share one in-flight refresh, so ten parallel requests meeting an expired
  token make one rotation rather than ten, which the server would read as refresh
  token reuse and answer by revoking the whole family. A proactive timer refreshes
  at 80 percent of the reported lifetime. `logout` calls the backend, which revokes
  the family, and clears memory whether or not that call succeeded.

  `@webbpulse/api-client` gains an `auth` option taking the narrow
  `AuthTokenProvider` contract, which turns on the retry-once-on-401 pipeline: one
  refresh, one replay, and a second 401 is thrown rather than starting a third
  attempt. The dependency edge stays one way, so this package still depends on
  nothing of the session machinery.

  **Breaking.** `@webbpulse/auth` no longer exports `TokenStore`,
  `MemoryTokenStorage`, `defaultTokenStorage` or `TokenStorage`, and
  `SessionManager` no longer accepts `mode: 'token'`, `tokenStorageKey`,
  `tokenStorage` or `extractToken`, nor exposes `getToken` and `setToken`. Section
  7.1 removes the `localStorage`-backed token store rather than deprecating it,
  because leaving it exported invites exactly the use the design exists to stop.

  **Migrating off the token store.** There is no drop-in replacement, because the
  replacement is a different mechanism rather than a different storage backend.
  An application holding a bearer token in `localStorage` moves to `AuthClient`:

  ```ts
  // Before, 0.3.0
  const session = new SessionManager<User, LoginBody>({
    client,
    mode: 'token',
    tokenStorageKey: 'access_token',
    loginPath: '/auth/token',
  });

  // After, 0.4.0
  const auth = createAuthClient<User>({
    baseUrl: config.apiBaseUrl,
    loadUser: (client) => client.get<User>('/users/me').then((r) => r.data),
    onSessionEnded: () => router.navigate('/login'),
  });
  const client = createApiClient({ baseUrl: config.apiBaseUrl, auth });
  ```

  Then replace `SessionProvider` with `AuthProvider` and `useSession` with
  `useAuth`. The state shape is close but not identical: `AuthState` adds
  `hasAccessToken` and `pendingMfa`, and its `status` values are unchanged.

  Users of the removed store are signed out once on the deploy that adopts this,
  because the token in their `localStorage` is no longer read and the refresh
  cookie does not exist yet. That is unavoidable and is the reason 7.1 calls this
  release a break rather than a deprecation.

  **`SessionManager` is kept, cookie only.** It is not the identity standard's
  mechanism and it is not the future, but Portfolio's admin panel uses a plain
  session cookie today and forcing that migration in the same release is a
  larger change than this one needs to be. `mode: 'cookie'` behaves exactly as it
  did in 0.3.0, with one addition: `isLoginComplete` replaces the `extractToken`
  hook that used to signal a pending second factor.

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.4.0

## 0.3.0

### Minor Changes

- Move to 0.3.0 with the rest of the set. No functional change to either package.

  Versioning here is independent per package, but the whole set has been released
  on one number so far and keeping it that way is worth a bystander bump at this
  size. The alternative is a matrix where `@webbpulse/auth` sits at 0.2.0 while
  `@webbpulse/api-client` is at 0.3.0, and since `auth` resolves `api-client`
  through its own peer range, a consumer reading two different minors has to work
  out whether the gap means anything. It does not, and one number says so.

  Revisit this once the package count or the release cadence makes a bystander
  bump cost more than the alignment is worth. The reasoning for independent
  versioning in principle is in `.changeset/README.md` and stands.

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.3.0

## 0.2.0

### Minor Changes

- d7ac2fa: First release of the shared packages.

  `@webbpulse/api-client` is a framework free typed fetch client: one base URL
  with `createDomainClient(prefix)` per domain, credentials included for the
  staging access gate, a typed `ApiError` carrying status, parsed body and the
  request id, jittered retry for idempotent methods only, and timeout and abort
  support.

  `@webbpulse/auth` generalises the session handling both applications wrote
  separately, with the React bindings in a separate `/react` entry so the core
  stays framework free.

  `@webbpulse/config` validates `import.meta.env` at startup and reports every
  problem at once rather than failing later at the first request.

  `@webbpulse/eslint-config` and `@webbpulse/tsconfig` carry the shared lint and
  compiler settings at the stricter of the two applications' current levels.

### Patch Changes

- Updated dependencies [d7ac2fa]
- Updated dependencies
  - @webbpulse/api-client@0.2.0
