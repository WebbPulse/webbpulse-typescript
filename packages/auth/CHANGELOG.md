# @webbpulse/auth

## 0.10.2

### Patch Changes

- Publish the canonical Prettier options as `@webbpulse/eslint-config/prettier` so
  consumers reference one shared setting instead of keeping their own copy.
- Updated dependencies
  - @webbpulse/api-client@0.10.2

## 0.10.1

### Patch Changes

- Bind the `useAuth` methods lazily in `@webbpulse/auth/react`. The hook bound all twelve `AuthClient` methods eagerly in a `useMemo`, so a test double standing in for the client had to implement the whole surface or throw `Cannot read properties of undefined (reading 'bind')` at render, whether the component under test touched those methods or not. Each method is now a getter that binds on first read and caches the wrapper against the client instance, so a stub needs only `initialize`, `getState`, `subscribe` and whichever flows the test exercises, and reading a method the client does not implement throws an error naming it.

  `UseAuthResult` is unchanged, every key is still present and enumerable, and the functions are still referentially stable for the client's lifetime. A real `AuthClient` implements the whole surface, so nothing about production behaviour changes.

  Every other package takes the lockstep version bump with no change.

- Updated dependencies
  - @webbpulse/api-client@0.10.1

## 0.10.0

### Minor Changes

- Add a React surface for the session ending to `@webbpulse/auth`. `AuthState` gains `sessionEnded`, which carries the `AuthSessionEndedError` whatever status code ended the session and is cleared by the next successful `login` or `initialize`; `error` keeps its old semantics and still stays null on an ordinary 401 expiry. `AuthProvider` takes an `onSessionEnded` prop that fires once per ending alongside the client's constructor hook, and the new `useSessionEnded` hook subscribes without prop drilling.

  `AuthClient` also gains `setUser(user)`, which writes a user the caller already has into the store with no request, and `reloadUser()`, which re-reads the user through the configured `loadUser` hook without rotating the refresh token; a 401 from that read ends the session the way a failed refresh does, and any other failure lands in `error` and leaves the session alone. Both are exposed on `useAuth`.

  Every other package takes the lockstep version bump with no change.

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.10.0

## 0.9.0

### Minor Changes

- Hoist the frontend primitives both applications had written twice.

  - `@webbpulse/qrcode`, new: a dependency free byte mode QR encoder for the short URIs a page renders inline, such as a TOTP provisioning URI. Exports `encodeQrCode`, `qrCodeSvgPath` and `QrMatrix`.
  - `@webbpulse/discovery`, new: what a deployment of the identity service can actually do, read before a sign-in page decides what to render. Tri-state `Availability`, one uncredentialed read per page load keyed on the full URL, passkey capability and OAuth provider gates.
  - `useOAuthCallback` on the `@webbpulse/auth` `./react` entry point: runs a handler once when the page was an OAuth callback landing, then strips the single-use parameters so a reload cannot replay a live MFA ticket.

  Every package lands on the same minor so the set stays in lockstep.

### Patch Changes

- f283602: Strip code comments and tighten the JSDoc on every exported symbol to one concise block. No behaviour change.
- Updated dependencies
- Updated dependencies [f283602]
  - @webbpulse/api-client@0.9.0

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

### Patch Changes

- Updated dependencies [05581dd]
  - @webbpulse/api-client@0.8.0

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

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.7.0

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

### Patch Changes

- Updated dependencies [54a7d83]
  - @webbpulse/api-client@0.6.0

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

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.5.0

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
