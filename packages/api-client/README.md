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

## Exports

`ApiClient`, `createApiClient`, `REQUEST_ID_HEADER`, the error types `ApiError`,
`ApiNetworkError` and `ApiTimeoutError`, the message formatter
`formatApiErrorMessage`, the URL helpers `joinUrl` and `serializeQuery`, and the
opt in envelope layer `toEnvelope`, `createEnvelopeClient` with the types
`ApiEnvelope`, `EnvelopeClient` and `EnvelopeOptions`.
