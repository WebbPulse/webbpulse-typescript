# @webbpulse/api-client

## 0.13.0

### Minor Changes

- 0483774: Added `usePolledQuery` and `useMutationWithRefetch` in the new
  `@webbpulse/api-client/react` entry point. `usePolledQuery` polls a fetcher on
  an interval with refetch on window focus and on return to visibility, pausing
  while the document is hidden, exponential backoff with jitter up to a cap that
  resets on success, an `enabled` flag, manual `refetch`, `isStale` and
  `lastUpdatedAt`, request de-duplication and abort of the in-flight request on
  unmount. It honours `waitForToken` so a query mounted during boot waits for the
  first refresh instead of going out anonymous. `useMutationWithRefetch`, with the
  `invalidateQueries` and `subscribeToRefetch` bus now exported from the root
  entry, lets a write trigger the polled queries reading the same key to refetch
  immediately. React remains an optional peer dependency and the root entry stays
  framework free.

## 0.12.1

- Lockstep version bump. No change to this package.

## 0.12.0

### Minor Changes

- Step the toolchain to TypeScript 6.0, the bridge release before 7. `base.json`
  now states `isolatedModules` explicitly, declarations are emitted by `tsc`
  rather than tsup, and the `typescript-eslint` floor moves to 8.70.0. Emitted
  JavaScript is unchanged.

One line per released version. Packages version in lockstep, so a version that changed nothing here says so. Full detail is in the git history.

## 0.11.0

- Lockstep version bump. No change to this package.

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
