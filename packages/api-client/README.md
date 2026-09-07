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

## Bodies

A plain object is JSON encoded. `URLSearchParams`, `FormData`, `Blob` and
`ArrayBuffer` pass through untouched so the runtime sets its own content type,
including the multipart boundary. Do not set `Content-Type` yourself for
`FormData`: unlike axios, this client forwards the header you give it, and a
`multipart/form-data` value with no boundary is unparseable by the server.

## Exports

`ApiClient`, `createApiClient`, `REQUEST_ID_HEADER`, the error types `ApiError`,
`ApiNetworkError` and `ApiTimeoutError`, the message formatter
`formatApiErrorMessage`, and the URL helpers `joinUrl` and `serializeQuery`.
