# @webbpulse/tsconfig

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

- Two gaps that adopting these packages in WebbPulse Portfolio turned up.

  `@webbpulse/api-client` gains an opt in `{ data, error }` envelope:
  `toEnvelope(call)` for a single call and `createEnvelopeClient(client)` for a
  whole client, with the `ApiEnvelope`, `EnvelopeClient` and `EnvelopeOptions`
  types. The throwing client is unchanged and stays the default. Portfolio wrote
  this adapter by hand to hold its existing call sites in place while the
  transport moved underneath them, so it is lifted here and tested once rather
  than copied into the next application that needs the same staging step.
  `ApiEnvelope.data` is typed `T | null`, which the hand rolled version was not,
  and the envelope carries `status`, `requestId` and `cause` alongside the
  message.

  `@webbpulse/tsconfig/node.json` no longer pins `"types": ["node"]`. It forced
  every consumer without `@types/node` installed to override it, and a Vite config
  file, which is what this config is applied to in both applications, needs no
  Node types at all. A project that wants the narrow set now states it, and
  narrowing only ever removes globals so it is the safe direction to leave to the
  consumer.
