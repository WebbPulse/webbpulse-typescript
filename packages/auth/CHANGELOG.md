# @webbpulse/auth

One line per released version. Packages version in lockstep, so a version that changed nothing here says so. Full detail is in the git history.

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
