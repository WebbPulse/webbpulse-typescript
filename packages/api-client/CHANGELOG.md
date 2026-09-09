# @webbpulse/api-client

## 0.3.0

### Minor Changes

- Read the WebbPulse error envelope as a first class shape.

  Every backend in the estate now renders one error body, built by `error_body` in
  the shared `webbpulse` Python package and installed application wide by
  `register_error_handlers`: `{ success, status, message, request_id, error_code,
details }`. `formatApiErrorMessage` understood FastAPI's `detail` and a bare
  `message` but not this, so the field the backend writes for a caller to read was
  the one field the formatter ignored, and CarModPicker kept a local
  `utils/apiError.ts` to read it.

  Four additions, all additive:

  - `WebbPulseErrorBody`, the typed envelope. `error_code` and `details` are
    optional rather than nullable, because a service that has not enabled them
    omits the keys entirely and the backend never writes an explicit `null`.
  - `isWebbPulseErrorBody(value)`, the type guard. It narrows on `success ===
false` plus a string `message` rather than on the full field set: `success:
false` is the discriminant a `detail` body and a bare `{ message }` both lack,
    and requiring `status` and `request_id` too would fail closed against a body
    that crossed a proxy which dropped a key, losing the message for no gain.
  - `getWebbPulseError(error)`, the accessor, returning `{ message, errorCode,
details, requestId, status }` off an `ApiError`. It always returns a value:
    for a body that is not an envelope, `message` falls through the same chain
    `formatApiErrorMessage` walks, so a call site renders it with no fallback of
    its own, and `errorCode` is `undefined` rather than absent, which is what lets
    a `switch` on it be exhaustive. `requestId` reads the body first and the
    response header second, since the same middleware writes both and a body that
    was logged or forwarded no longer has a response beside it. `status` comes
    from the response rather than the body's copy, because that is the one the
    browser actually saw.
  - `WebbPulseErrorInfo`, its return type. Flat and camel cased deliberately: the
    body is snake case because Python wrote it, and neither consumer should have
    to remember that `request_id` is the spelling on this one object.

  `formatApiErrorMessage` now prefers the envelope's `message` when present and is
  otherwise unchanged. Every existing export and behaviour is preserved: the
  FastAPI `detail` string, the validation array and the bare `message` are read
  exactly as before, and a body carrying `success: false` never also carries a
  meaningful `detail` to fall through to.

  This is what lets CarModPicker delete its local envelope reader and Portfolio
  branch on `error_code` rather than on message text.

## 0.2.0

### Minor Changes

- d7ac2fa: First release of the shared packages.

  `@webbpulse/api-client` is a framework free typed fetch client: one base URL
  with `createDomainClient(prefix)` per domain, credentials included for the
  staging access gate, a typed `ApiError` carrying status, parsed body and the
  request id, jittered retry for idempotent methods only, and timeout and abort
  support.

  `@webbpulse/auth` generalises the session handling both applications wrote
  separately, with the React bindings in a separate `/react` entry so the core
  stays framework free.

  `@webbpulse/config` validates `import.meta.env` at startup and reports every
  problem at once rather than failing later at the first request.

  `@webbpulse/eslint-config` and `@webbpulse/tsconfig` carry the shared lint and
  compiler settings at the stricter of the two applications' current levels.

- Two gaps that adopting these packages in WebbPulse Portfolio turned up.

  `@webbpulse/api-client` gains an opt in `{ data, error }` envelope:
  `toEnvelope(call)` for a single call and `createEnvelopeClient(client)` for a
  whole client, with the `ApiEnvelope`, `EnvelopeClient` and `EnvelopeOptions`
  types. The throwing client is unchanged and stays the default. Portfolio wrote
  this adapter by hand to hold its existing call sites in place while the
  transport moved underneath them, so it is lifted here and tested once rather
  than copied into the next application that needs the same staging step.
  `ApiEnvelope.data` is typed `T | null`, which the hand rolled version was not,
  and the envelope carries `status`, `requestId` and `cause` alongside the
  message.

  `@webbpulse/tsconfig/node.json` no longer pins `"types": ["node"]`. It forced
  every consumer without `@types/node` installed to override it, and a Vite config
  file, which is what this config is applied to in both applications, needs no
  Node types at all. A project that wants the narrow set now states it, and
  narrowing only ever removes globals so it is the safe direction to leave to the
  consumer.
