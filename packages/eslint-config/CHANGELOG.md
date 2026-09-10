# @webbpulse/eslint-config

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
  See the package CHANGELOG for the migration.

## 0.3.0

### Minor Changes

- Widen the `eslint` peer range to `^9.0.0 || ^10.0.0`.

  CarModPicker is on ESLint 10 and the 0.2.0 range of `^9.0.0` forced it to carry
  an `overrides` entry pinning the peer back, which suppresses the check rather
  than satisfying it. The config does work on ESLint 10, verified by running both
  `baseConfig` and `reactConfig` against sample sources under ESLint 10.10.0: the
  typed rules resolve, the `no-unsafe-*` family and `no-explicit-any` report as
  errors, `no-floating-promises` fires, and the react-hooks rules layer on top.
  Installing against ESLint 10 now resolves with no `ERESOLVE` warning, so the
  consumer side `overrides` block can go.

  `@eslint/js` deliberately stays pinned to `^9.39.1` as a direct dependency
  rather than widening alongside the peer. Version 9 declares no peer dependencies
  at all and its recommended rule set is consumed identically by both linters,
  while `@eslint/js@10` peer depends on `eslint@^10`, so widening the range would
  let npm resolve it under an ESLint 9 consumer and reintroduce the same conflict
  from the other direction. One pin serves both.

  `typescript-eslint` and `eslint-config-prettier` already declared ranges
  admitting ESLint 10 (`^8.57.0 || ^9.0.0 || ^10.0.0` and `>=7.0.0`), so neither
  needed a change.

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
