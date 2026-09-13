# @webbpulse/eslint-config

## 0.10.6

### Patch Changes

- The client `loadUser` receives now sends the session access token, so a
  `loadUser` hook pointed at a route behind the API gateway JWT authorizer
  resolves instead of taking a 401.

  When no `client` option is given, the auth client builds its own from
  `baseUrl`. That client was constructed with neither `auth` nor `getAuthToken`,
  so every request it made went out with no Authorization header. Since
  `settleAuthenticated` and `reloadUser` both hand that client to `loadUser`, the
  user load after a login or a refresh was unauthenticated. On
  www.carmodpicker.com the gateway log showed `POST /api/auth/refresh` 200
  followed immediately by `GET /api/users/me` 401 with no integration, which
  broke sign in.

  The constructed client now reads the token lazily through
  `getAuthToken: () => this.accessToken`, so it always carries the current one.
  It deliberately does not take `auth`: that option turns on refresh and replay
  on a 401, and the auth client's own login, refresh and logout calls must never
  recurse into a refresh. A `getAuthToken` supplied in `clientOptions` still
  wins.

  A caller-supplied `client` is untouched and stays the caller's responsibility,
  which the option's documentation and the README now say.

  Every other package takes the lockstep version bump with no change.

## 0.10.5

### Patch Changes

- `isAuthenticated` now stays true while a session call is in flight on a session
  that is already authenticated, so a route guard can redirect on
  `!isAuthenticated` without ejecting a signed in user.

  0.10.4 made `isLoading` mean "the session is not yet known", which is what a
  guard should gate its spinner on. That exposed the other half of the same
  problem: `isAuthenticated` was a bare `status === 'authenticated'`, and every
  token call moves `status` to `'loading'` for its duration, so an authenticated
  user read as signed out mid-call. Under 0.10.3 the old `isLoading` masked that by
  accident; with the mask gone, a guard redirecting on `!isAuthenticated` would
  send a signed in user to the login page on every later step-up or refresh.

  `useAuth` keeps `isAuthenticated` true while `status` is `'loading'` and the
  access token is still held, which is exactly the case of a call made on a live
  session, and false while a login from anonymous is in flight. `useSession` does
  the same from a new `hadUser` field on `SessionState`, since a `SessionManager`
  holds no token.

  `SessionState` gains `hadUser`. A consumer that asserts on the whole state
  object needs the new field; nothing else changes shape. The auth README gains a
  section stating which flag a guard gates on, so a consumer does not have to
  rediscover this.

  Every other package takes the lockstep version bump with no change.

## 0.10.4

### Patch Changes

- `isLoading` from `useAuth` and `useSession` now means the session is not yet
  known, rather than "a session call is in flight". Both hooks set it from a new
  latched `settled` flag on the state, true from the first transition to
  `authenticated` or `anonymous` and never false again, whichever call produced
  that first settled answer.

  Every token call set `status: 'loading'` at its start, so `isLoading` went true
  again on every login, TOTP completion, step-up and logout. Consumers read
  `isLoading` as "the session is not known yet" and gate whole route trees on it,
  so a login that answered with an MFA challenge unmounted the form mid-request
  and the pending challenge was lost with it. That broke sign-in for every TOTP
  user in production.

  A new `isBusy`, `status === 'loading'`, carries the in-flight meaning, so a
  button spinner or a disabled form has the flag it needs. `status` is unchanged
  and still moves to `'loading'` for the duration of a call.

  `AuthState` and `SessionState` each gain the `settled` boolean. A consumer that
  asserts on the whole state object needs the new field; nothing else changes
  shape.

  Every other package takes the lockstep version bump with no change.

## 0.10.3

### Patch Changes

- Honour `Retry-After` in the `@webbpulse/api-client` retry loop. A retryable
  failure carrying the header now waits exactly that long before the next
  attempt instead of the jittered backoff, which put all three attempts inside
  about 500 ms and turned one rate limited request into a burst against the
  limiter. A `Retry-After` longer than the new `retryAfterMaxMs` option
  (default 5000) is not waited out at all: the `ApiError` is thrown on the first
  attempt so the caller can surface the wait rather than stall. Failures with no
  `Retry-After` keep the jittered backoff unchanged.

  Every other package takes the lockstep version bump with no change.

## 0.10.2

### Patch Changes

- Publish the canonical Prettier options as `@webbpulse/eslint-config/prettier` so
  consumers reference one shared setting instead of keeping their own copy.

## 0.10.1

### Patch Changes

- Bind the `useAuth` methods lazily in `@webbpulse/auth/react`. The hook bound all twelve `AuthClient` methods eagerly in a `useMemo`, so a test double standing in for the client had to implement the whole surface or throw `Cannot read properties of undefined (reading 'bind')` at render, whether the component under test touched those methods or not. Each method is now a getter that binds on first read and caches the wrapper against the client instance, so a stub needs only `initialize`, `getState`, `subscribe` and whichever flows the test exercises, and reading a method the client does not implement throws an error naming it.

  `UseAuthResult` is unchanged, every key is still present and enumerable, and the functions are still referentially stable for the client's lifetime. A real `AuthClient` implements the whole surface, so nothing about production behaviour changes.

  Every other package takes the lockstep version bump with no change.

## 0.10.0

### Minor Changes

- Add a React surface for the session ending to `@webbpulse/auth`. `AuthState` gains `sessionEnded`, which carries the `AuthSessionEndedError` whatever status code ended the session and is cleared by the next successful `login` or `initialize`; `error` keeps its old semantics and still stays null on an ordinary 401 expiry. `AuthProvider` takes an `onSessionEnded` prop that fires once per ending alongside the client's constructor hook, and the new `useSessionEnded` hook subscribes without prop drilling. Every other package takes the lockstep version bump with no change.

## 0.9.0

### Minor Changes

- Hoist the frontend primitives both applications had written twice.

  - `@webbpulse/qrcode`, new: a dependency free byte mode QR encoder for the short URIs a page renders inline, such as a TOTP provisioning URI. Exports `encodeQrCode`, `qrCodeSvgPath` and `QrMatrix`.
  - `@webbpulse/discovery`, new: what a deployment of the identity service can actually do, read before a sign-in page decides what to render. Tri-state `Availability`, one uncredentialed read per page load keyed on the full URL, passkey capability and OAuth provider gates.
  - `useOAuthCallback` on the `@webbpulse/auth` `./react` entry point: runs a handler once when the page was an OAuth callback landing, then strips the single-use parameters so a reload cannot replay a live MFA ticket.

  Every package lands on the same minor so the set stays in lockstep.

## 0.8.0

### Minor Changes

- 05581dd: WebAuthn passkeys in `@webbpulse/auth`, matching the identity service's seven
  passkey routes.

  `registerPasskey` and `signInWithPasskey` each run a whole ceremony: fetch the
  options, call `navigator.credentials`, post the result back. Both legs live in
  one method because the challenge is a single-use row on the server, spent by one
  attempt whatever the outcome, and because the `challenge_id` the options route
  returns alongside the WebAuthn document is the server's own handle and must
  never reach the browser. A retry therefore starts again from the options leg,
  which is what calling the method again does naturally.

  `signInWithPasskey` takes an optional email and omits it for the discoverable,
  passwordless case. It resolves to either a session or an MFA challenge, since a
  passkey used without user verification on an account with a second factor
  enrolled leaves the login half done; that ticket is finished with the existing
  `completeTotp`, so there is no second passkey-specific method to learn.
  `listPasskeys`, `renamePasskey` and `deletePasskey` cover a settings page.

  Refusals a page has to render inline are outcomes rather than exceptions, on the
  rule the link, MFA and OAuth flows already follow: `rejected` for the one answer
  every failed ceremony gets, `already-registered`, `not-found`, `name-required`,
  `unavailable` for a deployment with passkeys or passwordless sign-in switched
  off, `rate-limited`, and `last-credential` for the delete that would strand a
  user with no password outside their own account. A dismissed browser prompt is a
  `cancelled` outcome too, because pressing Cancel is not a failure.

  `passkeysSupported` and `conditionalMediationAvailable` are the feature checks a
  sign-in page needs before it renders a button or arms autofill.
  `base64UrlToBuffer`, `bufferToBase64Url`, `toCreationOptions`, `toRequestOptions`
  and `credentialToJSON` are the conversion layer, used only when the browser
  lacks the native `parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`
  and `toJSON`; they touch exactly the fields the specification declares as
  `BufferSource`, so an option this version has never heard of still reaches the
  browser unchanged. `navigator.credentials` is injectable through a
  `WebAuthnAdapter` so a test never needs an authenticator.

  `AUTH_ERROR_CODES` gains the nine codes the passkey routes emit. The 0.7.0
  `loginWithPasskey` and `completePasskeyMfa` are gone: they were written against
  a route shape the server does not serve.

## 0.7.0

### Minor Changes

- OAuth sign-in, linking and unlinking in `@webbpulse/auth`, and `Retry-After` on
  rate-limit errors in `@webbpulse/api-client`.

  `@webbpulse/auth` gains the client side of the identity service's five OAuth
  routes. `oauthStartUrl` and `startOAuth` send the browser to the provider, a
  builder rather than a fetch because the start route answers a cross-origin
  redirect that script cannot follow. `readOAuthCallback` reads the landing page's
  single query parameter and narrows it to one of signed in, MFA required, linked
  or refused, with a fixed precedence so a stale parameter cannot outrank a live
  refusal. The session comes back as the ordinary refresh cookie set on that
  redirect, so there is no one-time code to exchange and no token in the URL.
  `linkOAuthProvider`, `listOAuthLinks` and `unlinkOAuthProvider` cover a settings
  page, with `already-linked`, `not-linked`, `last-sign-in-method`,
  `provider-unavailable` and `rate-limited` modelled as outcomes on the routes
  that can legitimately produce them. `AUTH_ERROR_CODES` gains the sixteen codes
  the OAuth routes emit.

  `@webbpulse/api-client` now keeps the `Retry-After` header on `ApiError` as
  `retryAfterSeconds`, parsed from both the delta-seconds and the HTTP-date form
  and present only on the statuses the transport treats as retryable. Callers had
  no way to read it before, because `ApiError` does not keep the `Response`.
  Nothing else about the transport changed.

## 0.6.0

### Minor Changes

- 54a7d83: Add the TOTP, recovery code and step-up flows to `@webbpulse/auth`.

  `AuthClient` gains five methods for the identity service's M4 routes, all of
  them behind the authorizer and all of them carrying the bearer token from this
  client, so they inherit its refresh-once behaviour on a 401: `enrolTotp`,
  `activateTotp`, `disableTotp`, `regenerateRecoveryCodes` and `stepUp`. The two
  legs of an MFA sign in, `login` and `completeTotp`, already existed and are
  unchanged.

  **These five return outcomes rather than throwing**, in the style of the M3 link
  flows and for a sharper version of the same reason: a user mistyping a six digit
  code is the single most likely thing to happen with an activation form open, and
  putting that in a `catch` puts the common path in the handler. They reject only
  for a network failure, a 500, or a 401 the client could not repair, which is the
  session ending rather than a form field error.

  `enrolTotp` returns the base32 seed and the `otpauth://` provisioning URI, once.
  There is no route that reads a seed back, so a user who loses it before
  activating enrols again and gets a new one. This package renders no QR code and
  adds no dependency to do it: hand `provisioningUri` to whatever generator the
  product already has. `activateTotp` returns the ten recovery codes the server
  issues with the activation, also once, since the server stores only their
  hashes. `regenerateRecoveryCodes` replaces the set and invalidates every
  previous code, which is the point of regenerating.

  `disableTotp` and `regenerateRecoveryCodes` both require a `code`, either a
  current TOTP code or an unspent recovery code, and both model `invalid-code`.
  A bearer token on its own is a weaker thing to hold than a bearer token plus a
  live factor, and those two routes either remove the second factor or void the
  printout that survives losing the phone, so each asks the user to prove the
  factor still works first.

  `stepUp` is not a second login. No refresh family is started and the refresh
  cookie is untouched, because the session is not new. What changes on the new
  token is `auth_time`, which becomes now, and `amr`, which gains the factor just
  satisfied. The token is adopted into the client's in-memory store and the
  proactive refresh timer is re-armed against it, so the next request carries it
  with no work at the call site; it is not in the outcome, because there is
  exactly one place an access token lives.

  `invalid-code` is deliberately one refusal covering a wrong code, a replayed
  code, no factor enrolled, a factor enrolled but not activated, a spent recovery
  code and one that never existed. The server answers all six identically so the
  second leg of login cannot be used to discover which accounts have TOTP enabled,
  and a client that split them would be inventing information it does not have.

  `AUTH_ERROR_CODES` appends the six codes the MFA routes emit: `INVALID_MFA_CODE`,
  `MFA_TICKET_INVALID`, `TOTP_ALREADY_ENABLED`, `NO_PENDING_ENROLMENT`,
  `MFA_NOT_CONFIGURED` and `NOT_AUTHENTICATED`. The twelve from section 7.3 and
  the five from M3 keep their order, which a test asserts as a prefix.

  `AuthPaths` gains `totpEnrol`, `totpActivate`, `totpDisable`, `recoveryCodes`
  and `stepUp`, defaulting to the standard's `/api/auth` issuer path.

  No breaking changes. Everything that existed in 0.5.0 keeps its shape.

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
