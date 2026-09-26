# @webbpulse/api-client

Framework free typed fetch client for the WebbPulse HTTP APIs.

The backends split into one Lambda per domain behind a single HTTP API that
routes by path prefix, so the browser sees one origin. This client models that:
one base URL, and `createDomainClient(prefix)` per domain.

```ts
import { createApiClient, ApiError } from '@webbpulse/api-client';

const client = createApiClient({ baseUrl: config.apiBaseUrl });
const buildLists = client.createDomainClient('/build-lists');

const { data, requestId } = await buildLists.get<BuildList[]>('/');
```

## Behaviour

- **Throws on a non 2xx.** `ApiError` carries `status`, the parsed `body`,
  `url`, `method` and the `requestId` the API echoed back.
- **Credentials included by default.** The staging access gate sets CloudFront
  signed cookies, and a request without credentials does not carry them.
- **Retry with full jitter backoff, for idempotent methods only.** GET, HEAD
  and OPTIONS retry on a network failure, a timeout, and on 408, 425, 429 and
  5xx. A POST never retries.
- **Timeout and abort.** A caller signal composes with the timeout, and every
  attempt clears its own timer and abort listener.
- **Request id passthrough.** Every request carries `x-request-id`, held
  constant across retries, and the response value comes back on `ApiResponse`.
- **Array query parameters repeat the key.** `ids=1&ids=2`, not `ids[]=1`.
- **Trailing slashes are preserved**, which the backend's
  `TrailingSlashMiddleware` depends on.

## Access tokens and the 401 retry

Section 7.2 of the identity standard puts the token attachment and the retry in
the transport rather than in every call site. Pass an `auth` provider and the
client reads the access token off it for every request and, on a 401, refreshes
once and replays the request once:

```ts
import { createApiClient } from '@webbpulse/api-client';
import { createAuthClient } from '@webbpulse/auth';

const auth = createAuthClient({ baseUrl: config.apiBaseUrl });
const client = createApiClient({ baseUrl: config.apiBaseUrl, auth });
```

`auth` is typed as `AuthTokenProvider`, which is two methods:
`getAccessToken(): string | null` and `refresh(): Promise<string | null>`. The
interface is declared here rather than imported, so this package does not depend
on `@webbpulse/auth` and anything satisfying those two methods will do.

- **The retry runs at most once, structurally.** `request` calls the single
  attempt path at most twice and has no loop, so a replay that also takes a 401
  throws rather than starting a second refresh. The replay also carries
  `skipAuthRetry` as a redundant guard.
- **A replay is safe for a POST**, which the transport retry would never do. The
  two cases are different: a 401 was rejected before it reached the handler, so
  nothing happened that a replay would repeat.
- **`refresh()` returning `null` means the session is gone.** The original 401
  is thrown and there is no replay.
- **Concurrency is the auth client's problem, not this one's.** Ten parallel
  requests taking a 401 together call `refresh()` ten times, and the auth
  client's single flight collapses that into one rotation. Any other provider
  must do the same, because a second rotation of a consumed refresh token reads
  as reuse on the server.
- **A caller who aborted does not trigger a refresh.**
- **`skipAuthRetry: true` on a `RequestOptions` opts a call out.** The identity
  routes set it: `/api/auth/refresh` cannot refresh itself, and a 401 from
  `/api/auth/login` means the password was wrong.

`auth` takes precedence over `getAuthToken`, which stays for an application that
has not adopted the auth client yet. With no `auth` configured the behaviour is
exactly what it was before, `onUnauthorized` included.

## The `{ data, error }` envelope

The client throws, and that stays the default. A rejection is the contract both
application inventories recommended, because an envelope nobody is type forced
to check is an envelope call sites forget to check.

Adopting the client in an application whose call sites already read
`response.error` is the case the default does not serve. Converting the
transport and sixty call sites in one change has no safe intermediate state, so
the envelope is available as an opt in layer on top. Import it and the throwing
client is untouched underneath.

`toEnvelope(call)` wraps a single call:

```ts
import { toEnvelope } from '@webbpulse/api-client';

const { data, error } = await toEnvelope(() =>
  client.get<Project[]>('/projects/')
);
```

`createEnvelopeClient(client)` wraps a whole client, with the same method names
and arguments as `ApiClient`:

```ts
import { createApiClient, createEnvelopeClient } from '@webbpulse/api-client';

const api = createEnvelopeClient(
  createApiClient({ baseUrl: config.apiBaseUrl }),
  {
    onError: console.error,
  }
);

const { data, error, status, requestId } =
  await api.get<Project[]>('/projects/');
const posts = api.createDomainClient('/posts'); // envelope client, same prefix rules
api.client; // the throwing client, for a call site that has already moved
```

The result is `ApiEnvelope<T>`:

| Field       | On success            | On failure                                     |
| ----------- | --------------------- | ---------------------------------------------- |
| `data`      | the parsed body       | `null`                                         |
| `error`     | `undefined`           | one line from `formatApiErrorMessage`          |
| `status`    | the response status   | the status, when a response was received       |
| `requestId` | the echoed request id | the echoed request id, for an `ApiError`       |
| `cause`     | `undefined`           | the thrown value, for a caller that needs more |

`data` is typed `T | null` rather than `T`, so the compiler makes the caller
check. `EnvelopeOptions` takes `fallbackMessage` for a thrown value carrying no
readable message, and `onError` for reporting. The package logs nothing itself:
pass `console.error` to keep that behaviour, or route it to a real reporter.

Take the envelope as a migration step, not a destination. New code should hold
the throwing client and use `try`/`catch`.

## Bodies

A plain object is JSON encoded. `URLSearchParams`, `FormData`, `Blob` and
`ArrayBuffer` pass through untouched so the runtime sets its own content type,
including the multipart boundary. Do not set `Content-Type` yourself for
`FormData`: unlike axios, this client forwards the header you give it, and a
`multipart/form-data` value with no boundary is unparseable by the server.

## The WebbPulse error envelope

Every WebbPulse backend renders one error shape, built by `error_body` in the
shared `webbpulse` Python package and installed application wide by
`register_error_handlers`. A 404 from a route, a 422 from request validation and
a 500 from an unhandled exception all arrive like this:

```json
{
  "success": false,
  "status": 404,
  "message": "No such build list.",
  "request_id": "0199a1c2-...",
  "error_code": "BUILD_LIST_NOT_FOUND",
  "details": [{ "field": "id", "message": "unknown" }]
}
```

The four base fields are always present. `error_code` and `details` are omitted
entirely unless the service opted into them, which is why both are optional
here: an absent key and an explicit `null` are different answers and the backend
only ever produces the former.

`getWebbPulseError(error)` is the accessor, and it always returns a value:

```ts
try {
  await client.post('/build-lists', body);
} catch (error) {
  if (error instanceof ApiError) {
    const { message, errorCode, details, requestId, status } =
      getWebbPulseError(error);
    if (errorCode === 'DUPLICATE_NAME') {
      setFieldError('name', message);
    } else {
      toast.error(message);
    }
  }
}
```

- **`message` is always a renderable string.** For a body that is not an
  envelope it falls through the same chain `formatApiErrorMessage` walks, so a
  call site never needs a fallback of its own.
- **`errorCode` is `undefined` rather than absent** when the service has not
  enabled `error_codes`, which is what lets a `switch` on it be exhaustive.
- **`requestId` reads the body's `request_id` first and the response header
  second.** The same middleware writes both, so this is a fallback rather than a
  choice between two sources of truth, and it means a body that has been logged
  or forwarded still carries the id.
- **`status` comes from the response**, not from the body's copy of it. The two
  disagree only when something rewrote one of them, and the response is the one
  the browser actually saw.

The returned object is flat and camel cased. The body is snake case because
Python wrote it, and a consumer should not have to remember that `request_id` is
the spelling on this one object when every other field it touches is camel case.

`isWebbPulseErrorBody(value)` is the type guard behind it, exported for a call
site that holds a body rather than an `ApiError`. It narrows on `success ===
false` plus a string `message`, not on the full field set: `success: false` is
the discriminant that a FastAPI `detail` body and a bare `{ message }` both
lack, and requiring `status` and `request_id` too would fail closed against a
body that crossed a proxy which dropped a key, losing the message for no gain.

`formatApiErrorMessage` prefers the envelope's `message` when it is present, and
is otherwise unchanged: FastAPI's `detail` (string or validation array) and a
bare `message` are read exactly as before.

## `Retry-After` on a rate limit

A 429 is the one refusal where the server usually knows how long the caller
should wait, and it says so in a `Retry-After` header rather than in the body.
`ApiError` now keeps it, as `retryAfterSeconds`:

```ts
try {
  await client.post('/api/auth/reset', { email });
} catch (error) {
  if (error instanceof ApiError && error.status === 429) {
    const wait = error.retryAfterSeconds;
    setBanner(
      wait === undefined
        ? 'Too many requests. Try again shortly.'
        : `Too many requests. Try again in ${String(wait)} seconds.`
    );
  }
}
```

- **It is set only on the statuses this client already treats as retryable**:
  408, 425, 429, 500, 502, 503 and 504. A `Retry-After` on a 404 is not a wait
  a caller should act on, and surfacing one would put a countdown in front of a
  permanent failure.
- **Both RFC 9110 forms are read.** `Retry-After: 120` is delta-seconds and is
  taken as it stands. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` is an
  HTTP-date and is turned into the seconds between the client's clock and that
  instant, rounded up and floored at zero, so a date already past reads as `0`
  rather than as a negative wait. An HTTP-date is only as good as the skew
  between the two machines, which is why the header's own specification prefers
  delta-seconds.
- **`undefined` means no usable hint**, whether the server sent no header or
  sent one that could not be read. Treat the value as a floor and keep whatever
  backoff the call site already has for the absent case.
- **Nothing else changed.** The field is additive: the retry policy, the
  statuses it retries on and the backoff are all what they were, and every
  existing construction of `ApiError` reads `undefined` on it.

`parseRetryAfter(value, now?)` and `retryAfterFromHeaders(status, headers)` are
exported for a call site holding a raw header or a `Response` rather than a
thrown `ApiError`.

## Polling, from `@webbpulse/api-client/react`

A separate entry point, so the core package stays framework free and an
application that only needs the client never pulls React into its bundle. React
is an optional peer dependency.

`usePolledQuery` keeps a panel current without a query layer. No react-query, no
cache and no shared store beyond the refetch keys, because the applications need
a handful of live panels rather than a framework.

```ts
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';

const { data, error, isStale, lastUpdatedAt, refetch } = usePolledQuery(
  ({ signal }) =>
    jobs.get<Job[]>('/', { query: { page }, signal }).then((r) => r.data),
  { intervalMs: 10_000, queryKey: ['jobs', page], auth }
);
```

- **The timer is a chained `setTimeout`**, measured from the end of one fetch to
  the start of the next rather than on a fixed `setInterval`, so a fetch slower
  than the interval cannot stack requests behind itself. `intervalMs` defaults
  to 30000.
- **A failure backs off** exponentially from the interval with jitter, capped at
  `maxBackoffMs` (default 15 seconds) and never below the interval, and a
  success resets it. `data` is left alone by a failure, so a panel keeps the
  last good value with the error beside it rather than blinking empty.
- **Every attempt has a deadline.** `attemptTimeoutMs` (default 30000, 0
  disables it) covers the whole attempt: the `waitForToken` wait and the
  fetcher, including any token refresh and the body read. An attempt that
  outlives it is aborted through its signal, rejects with
  `PolledQueryTimeoutError`, counts as a failure, and the next poll starts a new
  attempt, so a hung refresh or body read cannot stall the loop.
- **A watchdog restarts a stalled loop.** When no attempt has started or
  settled within `stallTimeoutMs` while the document is visible, polling
  restarts, and the check runs again the moment the document returns to
  visible. The default is `max(intervalMs, maxBackoffMs)` plus the attempt
  deadline, the longest gap a healthy loop can leave, and 0 disables it.
- **Focus and visibility.** `refetchOnFocus` refetches when the window regains
  focus and `refetchOnVisible` pauses the timer while the document is hidden and
  refetches on the way back. Both default to true: a background tab that polls is
  a bill and a battery drain for data nobody is reading.
- **Requests are de-duplicated.** A focus event landing on top of an interval
  tick is handed the running promise rather than starting a second request, and
  `refetch()` while one is in flight returns that one, unless it is past its
  deadline, in which case a new attempt replaces it.
- **The in-flight request is aborted on unmount**, and the signal the fetcher
  receives should be passed straight to the client as `{ signal }`.
- **`auth` honours the token readiness the client already exposes.** Given a
  provider with `waitForToken`, the first fetch waits on it, so a query mounted
  during boot reads with the restored session instead of going out anonymous and
  rendering a 401. An application on `@webbpulse/auth` passes `useQueryAuth()`
  from `@webbpulse/auth/react` rather than writing the adapter itself; the
  option stays a plain `{ waitForToken }`, so this package needs no dependency
  on that one.
- **`enabled: false`** stops the timer, drops any pending backoff and aborts an
  in-flight request, while keeping the last data on screen.
- **`isStale` and `lastUpdatedAt`** carry the age of the data. `staleTimeMs`
  defaults to `intervalMs`, so data reads stale once its replacement is due.
- **`queryKey` identifies the query**, not just its invalidation channel. Put
  the filters and the page cursor the fetcher closes over into the key, as
  `['jobs', page, status]`, and changing them starts a fresh query: the timer
  and any backoff reset, a fetch goes out immediately, the refetch subscription
  moves to the new key, and a response still in flight for the previous key is
  dropped rather than landing under the new one. Keys compare by a stable
  serialisation rather than by identity, so an array built inline on every
  render restarts nothing while its segments hold, and a caller whose key never
  changes sees the behaviour it always had. Remounting a list on a React `key`
  to force a re-read is no longer needed.
- **A key change clears `data` and raises `isLoading`**, unlike a failed poll,
  which keeps the last value. The previous key's rows answer a different
  question, so page one's list under a page two heading would be wrong rather
  than merely stale. A caller that would rather hold the old page while the new
  one loads keeps its own copy across the change.

`useMutationWithRefetch` wraps a write so the related queries refetch the moment
it lands, rather than waiting out the rest of their interval:

```ts
const { mutate, isMutating } = useMutationWithRefetch(
  (name: string) => jobs.post('/', { name }),
  ['jobs', page]
);
```

The invalidation is a notification rather than a cache write: each listening
query goes and reads again, so the server stays the only source of truth and a
write never has to know the shape of what the queries hold. Nothing is
invalidated when the write rejects, and the keys are read when `mutate` runs
rather than when the hook renders, so a key built from current props names what
the component is showing now. `invalidateQueries(keys)` and
`subscribeToRefetch(key, listener)` are exported from the root entry for a call
site outside React, alongside `serializeQueryKey(key)` for one that needs the
comparison itself. An array of primitives is one array key, so `['jobs', 1]`
invalidates that key rather than the two keys `jobs` and `1`; pass a list of
keys as an array holding at least one array key, `[['jobs', 1], 'counts']`.

## Exports

`ApiClient`, `createApiClient`, `REQUEST_ID_HEADER`, the auth contract type
`AuthTokenProvider`, the error types `ApiError`,
`ApiNetworkError` and `ApiTimeoutError`, the message formatter
`formatApiErrorMessage`, the WebbPulse error envelope reader
`getWebbPulseError` with its guard `isWebbPulseErrorBody` and the types
`WebbPulseErrorBody` and `WebbPulseErrorInfo`, the rate limit helpers
`parseRetryAfter` and `retryAfterFromHeaders`, the URL helpers `joinUrl` and
`serializeQuery`, the opt in envelope layer `toEnvelope`,
`createEnvelopeClient` with the types `ApiEnvelope`, `EnvelopeClient` and
`EnvelopeOptions`, and the refetch bus `invalidateQueries`,
`subscribeToRefetch` and `serializeQueryKey` with the types `QueryKey`,
`QueryKeyPart` and `Unsubscribe`.

`@webbpulse/api-client/react` adds `usePolledQuery` and
`useMutationWithRefetch`, the constants `DEFAULT_POLL_INTERVAL_MS`,
`DEFAULT_MAX_BACKOFF_MS` and `DEFAULT_ATTEMPT_TIMEOUT_MS`, the error
`PolledQueryTimeoutError`, and the types `PolledQueryOptions`,
`PolledQueryResult`, `PolledQueryFetcher`, `PolledQueryContext` and
`MutationWithRefetch`.
