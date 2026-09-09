# @webbpulse/auth

## 0.3.0

### Minor Changes

- Move to 0.3.0 with the rest of the set. No functional change to either package.

  Versioning here is independent per package, but the whole set has been released
  on one number so far and keeping it that way is worth a bystander bump at this
  size. The alternative is a matrix where `@webbpulse/auth` sits at 0.2.0 while
  `@webbpulse/api-client` is at 0.3.0, and since `auth` resolves `api-client`
  through its own peer range, a consumer reading two different minors has to work
  out whether the gap means anything. It does not, and one number says so.

  Revisit this once the package count or the release cadence makes a bystander
  bump cost more than the alignment is worth. The reasoning for independent
  versioning in principle is in `.changeset/README.md` and stands.

### Patch Changes

- Updated dependencies
  - @webbpulse/api-client@0.3.0

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

### Patch Changes

- Updated dependencies [d7ac2fa]
- Updated dependencies
  - @webbpulse/api-client@0.2.0
