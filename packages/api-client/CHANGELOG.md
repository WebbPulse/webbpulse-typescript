# @webbpulse/api-client

One line per released version. Packages version in lockstep, so a version that changed nothing here says so. Full detail is in the git history.

## 0.10.7

- `AuthTokenProvider.waitForToken` is an optional method; when present the client awaits it for the token before each attempt, so requests made during boot wait for the first refresh.

## 0.10.6

- Lockstep version bump. No change to this package.

## 0.10.5

- Lockstep version bump. No change to this package.

## 0.10.4

- Lockstep version bump. No change to this package.

## 0.10.3

- Honour `Retry-After` on a retryable response, and expose `parseRetryAfter` and `retryAfterFromHeaders`.

## 0.10.2

- Lockstep version bump. No change to this package.

## 0.10.1

- Lockstep version bump. No change to this package.

## 0.10.0

- Lockstep version bump. No change to this package.

## 0.9.0

- Lockstep version bump. No change to this package.

## 0.8.0

- Lockstep version bump. No change to this package.

## 0.7.0

- Keep `Retry-After` on `ApiError`.

## 0.6.0

- Lockstep version bump. No change to this package.

## 0.5.0

- Lockstep version bump. No change to this package.

## 0.4.0

- Lockstep version bump. No change to this package.

## 0.3.0

- Read the WebbPulse error envelope as a first class shape: `getWebbPulseError`, `isWebbPulseErrorBody` and `WebbPulseErrorBody`.

## 0.2.0

- First release of the shared packages.
