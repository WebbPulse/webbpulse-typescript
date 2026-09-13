# @webbpulse/discovery

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

- Updated dependencies
  - @webbpulse/auth@0.10.4

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

- Updated dependencies
  - @webbpulse/auth@0.10.3

## 0.10.2

### Patch Changes

- Publish the canonical Prettier options as `@webbpulse/eslint-config/prettier` so
  consumers reference one shared setting instead of keeping their own copy.
- Updated dependencies
  - @webbpulse/auth@0.10.2

## 0.10.1

### Patch Changes

- Bind the `useAuth` methods lazily in `@webbpulse/auth/react`. The hook bound all twelve `AuthClient` methods eagerly in a `useMemo`, so a test double standing in for the client had to implement the whole surface or throw `Cannot read properties of undefined (reading 'bind')` at render, whether the component under test touched those methods or not. Each method is now a getter that binds on first read and caches the wrapper against the client instance, so a stub needs only `initialize`, `getState`, `subscribe` and whichever flows the test exercises, and reading a method the client does not implement throws an error naming it.

  `UseAuthResult` is unchanged, every key is still present and enumerable, and the functions are still referentially stable for the client's lifetime. A real `AuthClient` implements the whole surface, so nothing about production behaviour changes.

  Every other package takes the lockstep version bump with no change.

- Updated dependencies
  - @webbpulse/auth@0.10.1

## 0.10.0

### Minor Changes

- Add a React surface for the session ending to `@webbpulse/auth`. `AuthState` gains `sessionEnded`, which carries the `AuthSessionEndedError` whatever status code ended the session and is cleared by the next successful `login` or `initialize`; `error` keeps its old semantics and still stays null on an ordinary 401 expiry. `AuthProvider` takes an `onSessionEnded` prop that fires once per ending alongside the client's constructor hook, and the new `useSessionEnded` hook subscribes without prop drilling. Every other package takes the lockstep version bump with no change.

### Patch Changes

- Updated dependencies
  - @webbpulse/auth@0.10.0

## 0.9.0

### Minor Changes

- Hoist the frontend primitives both applications had written twice.

  - `@webbpulse/qrcode`, new: a dependency free byte mode QR encoder for the short URIs a page renders inline, such as a TOTP provisioning URI. Exports `encodeQrCode`, `qrCodeSvgPath` and `QrMatrix`.
  - `@webbpulse/discovery`, new: what a deployment of the identity service can actually do, read before a sign-in page decides what to render. Tri-state `Availability`, one uncredentialed read per page load keyed on the full URL, passkey capability and OAuth provider gates.
  - `useOAuthCallback` on the `@webbpulse/auth` `./react` entry point: runs a handler once when the page was an OAuth callback landing, then strips the single-use parameters so a reload cannot replay a live MFA ticket.

  Every package lands on the same minor so the set stays in lockstep.

### Patch Changes

- Updated dependencies
- Updated dependencies [f283602]
  - @webbpulse/auth@0.9.0
