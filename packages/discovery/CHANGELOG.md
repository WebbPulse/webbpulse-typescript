# @webbpulse/discovery

## 0.13.4

### Patch Changes

- 6ebf85f: Float the `@webbpulse/auth` dependency on a caret range instead of pinning it
  exactly, so a consumer floating the same package resolves one copy rather than
  two.
- Updated dependencies [6ebf85f]
  - @webbpulse/auth@0.16.0

## 0.13.3

### Patch Changes

- Updated dependencies [6375ebe]
  - @webbpulse/auth@0.15.0

## 0.13.2

### Patch Changes

- @webbpulse/auth@0.14.1

## 0.13.1

### Patch Changes

- Updated dependencies [4ba9525]
  - @webbpulse/auth@0.14.0

## 0.13.0

- Lockstep version bump. No change to this package beyond the `@webbpulse/auth` dependency moving to 0.13.0.

## 0.12.1

- The OAuth provider list and the passkey availability document are read with `credentials: 'include'`, so an environment that gates its APIs on a cookie answers them instead of refusing with a 403. `fetchImpl` is still the override seam.

## 0.12.0

### Minor Changes

- Step the toolchain to TypeScript 6.0, the bridge release before 7. `base.json`
  now states `isolatedModules` explicitly, declarations are emitted by `tsc`
  rather than tsup, and the `typescript-eslint` floor moves to 8.70.0. Emitted
  JavaScript is unchanged.

### Patch Changes

- Updated dependencies
  - @webbpulse/auth@0.12.0

One line per released version. Packages version in lockstep, so a version that changed nothing here says so. Full detail is in the git history.

## 0.11.0

- New `./react` entry point with `useOAuthProviders`, the provider list read every sign-in page was holding its own copy of.

## 0.10.7

- Lockstep version bump. No change to this package.

## 0.10.6

- Lockstep version bump. No change to this package.

## 0.10.5

- Lockstep version bump. No change to this package.

## 0.10.4

- Lockstep version bump. No change to this package.

## 0.10.3

- Lockstep version bump. No change to this package.

## 0.10.2

- Lockstep version bump. No change to this package.

## 0.10.1

- Lockstep version bump. No change to this package.

## 0.10.0

- Lockstep version bump. No change to this package.

## 0.9.0

- First release. Capability discovery for the identity service, with a tri-state `Availability` and one uncredentialed read per page load.
