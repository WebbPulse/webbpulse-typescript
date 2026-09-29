# @webbpulse/api-client

## 0.17.1

### Patch Changes

- 89a95a2: `usePolledQuery` derives `isLoading` from whether the query is enabled and a fetch for the current key has settled. A query enabled after its first render now reads loading until its first data or error arrives instead of reporting false with no data, and a query disabled before its first fetch settled no longer stays loading. Background and hidden-tab polls still never raise it.

## 0.17.0

### Minor Changes

- 59d361a: Idle backoff and ETag polling for `usePolledQuery`. Once the page has seen no pointer, key, wheel, touch or focus activity for `idleAfterMs` (default 2 minutes), each poll stretches the interval by `idleBackoffMultiplier` (default 2) up to `maxIdleIntervalMs` (default 5 minutes), and the first activity afterwards refetches once and returns to `intervalMs`; `idleAfterMs: 0` turns it off. `hiddenIntervalMs` keeps a hidden tab polling at a slow pace instead of pausing (default 0, which pauses). The fetcher context now carries `etag` and `headers` (`If-None-Match` once a validator is held); a fetcher resolving to `polledResponse(response)` has its ETag remembered per query key, and a 304 keeps the held `data` with its identity and writes no data or error state. The client resolves a 304 instead of throwing when the request sent `If-None-Match` or `If-Modified-Since`. Adds `PolledResponse`, `PolledQueryNotModifiedError`, `ConditionalResponse`, `IF_NONE_MATCH_HEADER`, the idle defaults as constants, and the shared activity tracker `subscribeToActivity` and `idleForMs`. Existing callers keep working unchanged, but pick up idle backoff at the defaults.

## 0.16.0

### Minor Changes

- 287618c: Step-up gate. `@webbpulse/api-client` classifies a 401 carrying `STEP_UP_REQUIRED` (or `WWW-Authenticate: Bearer error="insufficient_user_authentication"`) as a `StepUpRequiredError` with `maxAge`, which skips the refresh and replay and does not call `onUnauthorized`; adds `isStepUpRequired`, `apiErrorFromResponse` and `STEP_UP_REQUIRED_ERROR_CODE`, the `skipUnauthorizedHandling` request option, which reads a 401 as a refusal with no refresh, replay or `onUnauthorized`, and `reset()` on `useMutationWithRefetch`. `@webbpulse/auth` sends every step-up with `skipUnauthorizedHandling`, so a wrong password or code never signs the person out, and adds `stepUp({ password })`, `authTime()` and `isRecentlyAuthenticated(maxAgeSeconds)` (also on `useAuth`), `StepUpCancelledError` and `classifyPasswordStepUpError`, and the headless `useStepUp` hook in `@webbpulse/auth/react` with `withStepUp`, `submit`, `cancel`, `open`, `maxAge`, `pending` and `error`.

## 0.15.0

### Minor Changes

- 50006ac: `usePolledQuery` can no longer stall for good. Each attempt now runs under a
  deadline covering the whole of it, the `waitForToken` wait and the fetcher
  including any token refresh and the body read, set by the new
  `attemptTimeoutMs` option (default `DEFAULT_ATTEMPT_TIMEOUT_MS`, 30 seconds, 0
  disables it). An attempt that outlives it is aborted through its signal, rejects
  with the new `PolledQueryTimeoutError`, counts as a failure for backoff, and the
  next poll starts a new attempt; an in-flight attempt past its deadline is never
  handed to a later `refetch`, focus or visibility trigger, which also covers a
  background tab whose timers were throttled. `DEFAULT_MAX_BACKOFF_MS` drops from
  five minutes to 15 seconds, and the backoff never falls below `intervalMs`. A
  new watchdog restarts polling when no attempt has started or settled within
  `stallTimeoutMs` (default `max(intervalMs, maxBackoffMs)` plus the attempt
  deadline, 0 disables it); it only fires while the document is visible, checks
  again the moment it returns to visible, and is torn down on unmount. Callers
  that wrapped their fetcher in their own deadline and watchdog can drop that
  workaround.

## 0.14.0

### Minor Changes

- 2950ea3: `usePolledQuery` now treats `queryKey` as the identity of the query rather than
  only its invalidation channel, so a caller whose key changes because its filters
  or page cursor changed re-reads instead of showing the previous key's data
  forever. A key change resets the timer and any backoff, fetches immediately,
  moves the refetch subscription to the new key, and drops a response still in
  flight for the old key; `data` clears and `isLoading` reads true until the new
  result lands, because the old rows answer a different question. `QueryKey` now
  accepts an array of primitives alongside a string and keys compare by a stable
  serialisation, so an array assembled inline on every render restarts nothing.
  Adopters that remounted a list on a React `key` to force a re-read can drop that
  workaround, and a caller whose key never changes is unaffected.

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
