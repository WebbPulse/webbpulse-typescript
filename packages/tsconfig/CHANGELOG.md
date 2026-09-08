# @webbpulse/tsconfig

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
