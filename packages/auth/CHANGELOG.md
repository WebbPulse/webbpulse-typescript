# @webbpulse/auth

## 0.23.0

### Minor Changes

- 534f1c0: Browser to desktop session handoff, the client side of webbpulse's `/desktop-handoff` routes. The desktop app calls `createDesktopHandoffPkce()` and opens `desktopHandoffLaunchUrl(...)` in the system browser. The handoff page calls `AuthClient.handOffToDesktop()` (or `mintDesktopHandoff({ codeChallenge, scheme })`) and opens the returned `callbackUrl`, `<scheme>://auth/handoff?code=...`. The app then calls `completeDesktopHandoff({ url, codeVerifier })` (or `exchangeDesktopHandoff({ code, codeVerifier, scheme })`), which adopts the session as a sign-in would. Both sides refuse a scheme off the new `desktopHandoffSchemes` option, which is empty by default and throws on a web scheme. Both resolve to outcome unions rather than throwing. New `AuthPaths` entries `desktopHandoff` and `desktopHandoffExchange`. `HANDOFF_SCHEME_NOT_ALLOWED`, `HANDOFF_INVALID_REQUEST`, `HANDOFF_INVALID` and `HANDOFF_DISABLED` join `AUTH_ERROR_CODES`.

## 0.22.0

### Minor Changes

- b843a48: Answer a login MFA challenge with a passkey. `AuthClient.completeMfaWithPasskey({ ticket })`, also on `useAuth()`, runs the options leg with the MFA ticket, the WebAuthn ceremony and the verify leg, then stores the session exactly as `completeTotp` does. It resolves to a `PasskeyMfaOutcome` rather than throwing for `rejected`, `ticket-invalid`, `unavailable`, `no-passkeys`, `rate-limited`, `cancelled` and `unsupported`. New `PasskeyPaths` entries `loginMfaPasskeyOptions` and `loginMfaPasskeyVerify` default to `/api/auth/login/mfa/passkey/options` and `/api/auth/login/mfa/passkey/verify`. `PASSKEY_FACTOR` (`'passkey'`) sits beside `TOTP_FACTOR` for reading `factors`, and `PASSKEY_FACTOR_DISABLED` joins `AUTH_ERROR_CODES`.

## 0.21.0

### Minor Changes

- 070475e: Hoists frontend helpers the products each carried a copy of. `@webbpulse/auth` adds `safeReturnPath` and `isSafeReturnPath`, which accept only a root relative path and refuse `//host`, backslashes, control characters, schemes and percent-encoded variants of them, and `identityReturnUrl`, which accepts an absolute URL back to one exact identity route on the identity origin. `@webbpulse/api-client` adds `getErrorCode(error: unknown)`, the envelope `error_code` or `undefined`. `@webbpulse/config` adds the `loadAppConfig` options `apiBaseUrlAliases`, further variable names read when `VITE_API_BASE_URL` is blank, and `assumeHttps`, which gives a bare host an `https://` scheme. All additive; existing calls behave as before.

### Patch Changes

- Updated dependencies [070475e]
  - @webbpulse/api-client@0.18.0

## 0.20.0

### Minor Changes

- 4f285e6: `readOAuthCallback` reads the OAuth MFA ticket from the URL fragment (`#mfa_ticket=<t>`, where webbpulse 0.80.0 puts it) and falls back to the query for older servers. `stripOAuthParams` also removes the fragment ticket, keeping other fragment content and dropping an empty `#`. Both now accept a `URL` or `Location` as well as an href string (new `OAuthCallbackHref` type). Callers must pass something that includes the hash, such as `location.href`, never `location.search`; `useOAuthCallback` already does.

## 0.19.3

### Patch Changes

- 849e059: MFA route `rate-limited` outcomes read `retryAfter` from the `Retry-After` header first, then the body. A second-factor lockout (`TOO_MANY_ATTEMPTS`) sends only the header, so `stepUp({ code })`, `disableTotp` and `regenerateRecoveryCodes` used to report no wait.

## 0.19.2

### Patch Changes

- Updated dependencies [59d361a]
  - @webbpulse/api-client@0.17.0

## 0.19.1

### Patch Changes

- f534c80: `usePasskeySignInButton` aborts the armed autofill (conditional mediation) request before a click starts its own ceremony, and arms it again afterwards unless the click signed the person in. A browser refuses a second WebAuthn request while one is pending, so in Chromium the button failed with "A request is already pending" on every page that armed autofill.

## 0.19.0

### Minor Changes

- 0087075: `OAuthLink` gains an optional `login`, the provider username (the GitHub login) that `GET /oauth/links` returns from webbpulse 0.65, so a connected accounts section can show `@octocat` rather than only the provider email. `parseOAuthLinks` sets it only when the server sent a non-empty string.

## 0.18.0

### Minor Changes

- 287618c: Step-up gate. `@webbpulse/api-client` classifies a 401 carrying `STEP_UP_REQUIRED` (or `WWW-Authenticate: Bearer error="insufficient_user_authentication"`) as a `StepUpRequiredError` with `maxAge`, which skips the refresh and replay and does not call `onUnauthorized`; adds `isStepUpRequired`, `apiErrorFromResponse` and `STEP_UP_REQUIRED_ERROR_CODE`, the `skipUnauthorizedHandling` request option, which reads a 401 as a refusal with no refresh, replay or `onUnauthorized`, and `reset()` on `useMutationWithRefetch`. `@webbpulse/auth` sends every step-up with `skipUnauthorizedHandling`, so a wrong password or code never signs the person out, and adds `stepUp({ password })`, `authTime()` and `isRecentlyAuthenticated(maxAgeSeconds)` (also on `useAuth`), `StepUpCancelledError` and `classifyPasswordStepUpError`, and the headless `useStepUp` hook in `@webbpulse/auth/react` with `withStepUp`, `submit`, `cancel`, `open`, `maxAge`, `pending` and `error`.

### Patch Changes

- Updated dependencies [287618c]
  - @webbpulse/api-client@0.16.0

## 0.17.0

### Minor Changes

- dcee5eb: `@webbpulse/auth/react` gains `useDismissedUntilSignIn(key)`, the state behind a
  dismissible notice such as an "in development" banner that should greet every
  new session. It returns `{ dismissed, dismiss }` and draws nothing. The flag lives
  in `sessionStorage` under `DISMISSAL_STORAGE_PREFIX` plus the key, so it is per
  tab. It records whether it was made signed in or signed out and lapses when the
  session settles on the other side: a dismissal made in a session lapses on the
  sign-out or expiry that ends it, so the next sign-in shows the notice again, and
  one made while signed out survives reloads and lapses on the next sign-in.
  Nothing lapses while the session is unknown or during a token refresh. Storage
  that throws falls back to memory for the page's lifetime.

## 0.16.1

### Patch Changes

- Updated dependencies [50006ac]
  - @webbpulse/api-client@0.15.0

## 0.16.0

### Minor Changes

- 6ebf85f: Model an unsupported passkey ceremony, and add a passkey step-up.

  A browser that accepts the support probes and then refuses
  `navigator.credentials.get` no longer escapes as an unhandled rejection. A
  `DOMException` named `NotSupportedError`, which headless Chromium raises for a
  discoverable credential, and every browser-side rejection of a
  `mediation: 'conditional'` ceremony now settle as a new `unsupported` refusal,
  leaving `state.error` null. An autofill sign-in armed on mount needs no
  `.catch`. `cancelled` is unchanged, and registration models `unsupported` too.

  `stepUpWithPasskey` gates a sensitive action on a passkey rather than a typed
  code: an options leg scoped to the signed-in caller at
  `stepUpPasskeyOptions`, then the ordinary step-up route for the assertion,
  adopting the fresher token exactly as `stepUp` does. An account with no passkey
  answers the new `no-passkeys` refusal. `stepUp` and `stepUpWithPasskey` are now
  exposed on `useAuth`.

## 0.15.0

### Minor Changes

- 6375ebe: Share the identity client singleton and the sign-in controls' behaviour.

  `@webbpulse/auth/browser` is a new entry point holding
  `createIdentityClientSingleton`, the lazy `createAuthClient` build every product
  had copied: the origin derivation, the `credentials: 'include'` and 30 second
  client options, the current-user load, and the `setWebAuthnAdapterForTests` and
  `resetForTests` seams. `apiBaseUrl` takes a thunk so a test that restubs the
  environment and resets gets a client built from the new value.
  `identityOriginFrom` and `identityUrl` ship from the same entry, carried rather
  than imported because `@webbpulse/discovery` already depends on this package.

  `@webbpulse/auth/react` gains two headless hooks matching the `/panels`
  precedent. `usePasskeySignInButton` is the support gate, the aborted conditional
  ceremony and the click handler in one, and `useOAuthProviderLinks` turns a
  provider list into built start URLs. Both return state and handlers only, so a
  product keeps its own markup, classes and copy.

## 0.14.1

### Patch Changes

- Updated dependencies [2950ea3]
  - @webbpulse/api-client@0.14.0

## 0.14.0

### Minor Changes

- 4ba9525: Add `useQueryAuth` to `@webbpulse/auth/react`, the `auth` option for
  `usePolledQuery` bound to the client already in context, so an application does
  not hand-roll the adapter and cannot ship a query that boots anonymous.

## 0.13.0

- Lockstep version bump. No change to this package beyond the `@webbpulse/api-client` dependency moving to 0.13.0.

## 0.12.1

- Lockstep version bump. No change to this package.

## 0.12.0

### Minor Changes

- Step the toolchain to TypeScript 6.0, the bridge release before 7. `base.json`
  now states `isolatedModules` explicitly, declarations are emitted by `tsc`
  rather than tsup, and the `typescript-eslint` floor moves to 8.70.0. Emitted
  JavaScript is unchanged.

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.12.0

One line per released version. Packages version in lockstep, so a version that changed nothing here says so. Full detail is in the git history.

## 0.11.0

- New `./panels` entry point: `usePasskeyPanel`, `useConnectedAccountsPanel`, `useTotpPanel` and the `useListPanel` core, headless state machines for the identity settings panels. `./react` gains `usePasskeySignInSupport` and `useEmailVerificationLink`. `SessionManager` and its React bindings are deprecated and will be removed in the next major.

## 0.10.7

- `AuthClient.waitForToken` awaits the first refresh of the page load, and the api-client awaits it before a request, so a domain call made during boot carries the restored session instead of going out anonymous.

## 0.10.6

- `loadUser` now receives a client that sends the session access token, so a `loadUser` hook pointed at a route behind the gateway JWT authorizer resolves instead of taking a 401.

## 0.10.5

- `isAuthenticated` stays true while a session call is in flight on an already authenticated session, so a guard can redirect on `!isAuthenticated` without ejecting a signed in user. `SessionState` gains `hadUser`.

## 0.10.4

- `isLoading` from `useAuth` and `useSession` means the session has never settled, and `isBusy` is the new flag for a call in flight.

## 0.10.3

- Lockstep version bump. No change to this package.

## 0.10.2

- Lockstep version bump. No change to this package.

## 0.10.1

- `useAuth` binds each client method on first read rather than eagerly, so a test double needs only the methods the component under test calls.

## 0.10.0

- `AuthState` gains `sessionEnded` and the React entry gains `useSessionEnded` and an `onSessionEnded` prop on `AuthProvider`.

## 0.9.0

- Add `useOAuthCallback` to the `./react` entry point.

## 0.8.0

- WebAuthn passkey enrolment, sign-in and management.

## 0.7.0

- OAuth sign-in, linking and unlinking.

## 0.6.0

- TOTP enrolment, recovery codes and step-up.

## 0.5.0

- Email verification and password reset flows.

## 0.4.0

- Implement the frontend contract of the unified identity standard, sections 7.1 to 7.3: `AuthClient`, the in-memory access token and the React bindings.

## 0.3.0

- Lockstep version bump. No change to this package.

## 0.2.0

- First release of the shared packages.
