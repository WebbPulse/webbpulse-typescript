# @webbpulse/config

## 0.14.0

### Minor Changes

- 070475e: Hoists frontend helpers the products each carried a copy of. `@webbpulse/auth` adds `safeReturnPath` and `isSafeReturnPath`, which accept only a root relative path and refuse `//host`, backslashes, control characters, schemes and percent-encoded variants of them, and `identityReturnUrl`, which accepts an absolute URL back to one exact identity route on the identity origin. `@webbpulse/api-client` adds `getErrorCode(error: unknown)`, the envelope `error_code` or `undefined`. `@webbpulse/config` adds the `loadAppConfig` options `apiBaseUrlAliases`, further variable names read when `VITE_API_BASE_URL` is blank, and `assumeHttps`, which gives a bare host an `https://` scheme. All additive; existing calls behave as before.

### Patch Changes

- 5b7cadb: The `@webbpulse/tsconfig` dev dependency floats as `^0.13.0` instead of the exact 0.13.0 pin. No runtime change.

## 0.13.0

- Lockstep version bump. No change to this package.

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

- Lockstep version bump. No change to this package.

## 0.8.0

- Lockstep version bump. No change to this package.

## 0.7.0

- Lockstep version bump. No change to this package.

## 0.6.0

- Lockstep version bump. No change to this package.

## 0.5.0

- Lockstep version bump. No change to this package.

## 0.4.0

- Lockstep version bump. No change to this package.

## 0.3.0

- Express the dev backend switch and the API path prefix in `loadAppConfig`.

## 0.2.0

- First release of the shared packages.
