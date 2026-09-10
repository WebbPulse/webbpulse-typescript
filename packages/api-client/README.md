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

## Exports

`ApiClient`, `createApiClient`, `REQUEST_ID_HEADER`, the auth contract type
`AuthTokenProvider`, the error types `ApiError`,
`ApiNetworkError` and `ApiTimeoutError`, the message formatter
`formatApiErrorMessage`, the WebbPulse error envelope reader
`getWebbPulseError` with its guard `isWebbPulseErrorBody` and the types
`WebbPulseErrorBody` and `WebbPulseErrorInfo`, the URL helpers `joinUrl` and
`serializeQuery`, and the opt in envelope layer `toEnvelope`,
`createEnvelopeClient` with the types `ApiEnvelope`, `EnvelopeClient` and
`EnvelopeOptions`.
