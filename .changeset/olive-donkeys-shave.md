---
'@webbpulse/eslint-config': minor
'@webbpulse/api-client': minor
'@webbpulse/tsconfig': minor
'@webbpulse/config': minor
'@webbpulse/auth': minor
---

First release of the shared packages.

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
