# @webbpulse/tsconfig

Shared TypeScript compiler configurations.

```json
{ "extends": "@webbpulse/tsconfig/vite-app.json" }
```

| Config          | For                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `base.json`     | Everything else extends this. Strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature`. |
| `library.json`  | Published packages. Declarations and source maps.                                                                                             |
| `vite-app.json` | Vite applications. DOM libs and the JSX transform.                                                                                            |
| `node.json`     | Node tooling and scripts.                                                                                                                     |

`moduleResolution` is `bundler` throughout, which both applications already
use.

## `node.json` and `types`

`node.json` sets no `types` array. It used to pin `["node"]`, which forced every
consumer without `@types/node` installed to override it: a Vite config file is
compiled by `node.json` in both applications and needs no Node types at all, and
a `types` entry that cannot be resolved is a compile error rather than a
warning.

With the array absent, TypeScript includes whatever `@types` packages are in
scope, which is the right default for a config that spans Vite configs, scripts
and tooling alike. A project that does want the narrow set states it, and
narrowing is the safe direction because it only ever removes globals:

```json
{
  "extends": "@webbpulse/tsconfig/node.json",
  "compilerOptions": { "types": ["node"] }
}
```
