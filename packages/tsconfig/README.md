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
