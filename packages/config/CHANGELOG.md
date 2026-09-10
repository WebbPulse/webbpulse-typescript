# @webbpulse/config

## 0.5.0

### Minor Changes

- Add the email verification and password reset flows to `@webbpulse/auth`.

  `AuthClient` gains four methods, one for each of the identity service's link
  routes: `requestEmailVerification`, `confirmEmailVerification`,
  `requestPasswordReset` and `confirmPasswordReset`. Section 2.6 of the identity
  standard calls verification and reset one primitive, "a single-use,
  time-limited, signed link", and these keep that symmetry.

  All four are anonymous, matching the routes. A user who never finished signing
  up has no session to authenticate with, and the resend has to work for exactly
  that person.

  **These four return outcomes rather than throwing.** Every other method on the
  client rejects on failure, which is right for a login: there is no result to
  hand back. These are different, because their likely non-success is an answer a
  form has to render next to a field rather than an exception, such as "this link
  has expired" or "that password is too short". They resolve to a discriminated
  union in the style of `LoginOutcome`, and reject only for a network failure or a 500. `confirmPasswordReset` distinguishes `invalid-link`, `password-rejected`
  and `rate-limited`, because the remedies differ.

  `VERIFY_EMAIL_PATH` (`/verify-email`) and `RESET_PASSWORD_PATH`
  (`/reset-password`) are the two SPA paths the mailed links land on, and must
  equal `VERIFY_LINK_PATH` and `RESET_LINK_PATH` in the backend's
  `webbpulse.identity.verification`, which is what builds the URL. Nothing enforces
  that across the two repositories at build time, so both sides carry a test
  asserting the literal. `readLinkToken` reads the token off the current location,
  optionally conditioned on the page being the landing page for that flow, so one
  page handling both links cannot present a verification token to the reset
  endpoint.

  `AUTH_ERROR_CODES` appends five codes the link routes emit and section 7.3 does
  not name, because it was written before those routes existed: `INVALID_LINK`,
  `PASSWORD_TOO_SHORT`, `PASSWORD_REJECTED`, `TOO_MANY_ATTEMPTS` and
  `EMAIL_NOT_CONFIGURED`. The twelve from 7.3 keep their order, which a test
  asserts as a prefix.

  Two behaviours worth knowing. The request routes answer identically whether or
  not the address has an account, per section 5.4, so `EmailRequestOutcome` has no
  `sent: false` and a caller must not try to infer one. And a successful
  `confirmPasswordReset` revokes every refresh family for the account, this
  browser's included, so the client drops its own token; it does not fire
  `onSessionEnded`, because the caller is on the reset page and its own success
  branch navigates.

  No breaking changes. Everything that existed in 0.4.0 keeps its shape.

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

- Express the dev backend switch and the API path prefix in `loadAppConfig`.

  CarModPicker could not describe its configuration with 0.2.0. It has a dev only
  backend switch (`VITE_BACKEND=staging|production`, behind `npm run dev:staging`
  and `dev:prod`) and appends the `/api` prefix its backend mounts every router
  under, so it had to resolve the URL itself before calling `loadAppConfig`. That
  puts the one piece of URL selection outside the layer that exists to validate
  it, which is the pattern this package was written to remove.

  Two options, both defaulting to absent:

  - `backendTargets`, a map from the `VITE_BACKEND` value to the base URL that
    value selects. Consulted **only when `DEV` is true**, so a stray `VITE_BACKEND`
    in a deploy environment cannot repoint a shipped production bundle at another
    backend; a convenience that survives into production is a way to ship the
    wrong URL. A matched target wins over `VITE_API_BASE_URL`, since a developer
    who ran `dev:staging` meant it. An unset switch, an unmapped value and a
    mapped `undefined` all fall through to the normal resolution, the last of
    which lets a caller pass `import.meta.env.VITE_STAGING_API_URL` straight in
    without guarding it. Matching is case insensitive, and the selected URL goes
    through the same reader as `VITE_API_BASE_URL`, so a malformed entry throws at
    startup naming the key that supplied it rather than the one that selected it.
    `backendTargetKey` renames the switch variable.
  - `apiPathPrefix`, a path suffix appended after the base URL is resolved. The
    deploy writes a bare origin because that is what the Terraform `api_url`
    output is, so something has to join the two, and doing it here means the
    joined value is what gets validated. Appending is idempotent: a base URL whose
    path already ends with the prefix is left alone, so `/api` never becomes
    `/api/api`. That matters because the two applications disagree today about
    whether the variable holds the origin or the full base, and both spellings are
    in deploy configuration right now.

  `LoadAppConfigOptions` is now exported. A call passing neither option behaves
  exactly as it did in 0.2.0.

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
