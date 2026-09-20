# @webbpulse/auth

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
