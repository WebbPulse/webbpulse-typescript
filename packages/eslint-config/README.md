# @webbpulse/eslint-config

Shared ESLint flat configurations.

```js
// eslint.config.js
import { baseConfig } from '@webbpulse/eslint-config/base';

export default baseConfig({
  project: ['./tsconfig.json'],
  tsconfigRootDir: import.meta.dirname,
});
```

`baseConfig` gives type checked TypeScript rules with the `no-unsafe-*` family
and `no-explicit-any` promoted to errors, and `eslint-config-prettier` last.

`reactConfig({ plugins })` layers React rules on top. The React plugins are
passed in by the consumer rather than depended on here: the two applications
are on different plugin sets today, and forcing the union on both would make
this config a blocker for whichever one is slower to adopt.

```js
import { reactConfig } from '@webbpulse/eslint-config/react';
import reactHooks from 'eslint-plugin-react-hooks';

export default reactConfig({
  project: ['./tsconfig.app.json'],
  tsconfigRootDir: import.meta.dirname,
  plugins: { 'react-hooks': reactHooks },
});
```

## ESLint 9 and ESLint 10

The peer range is `^9.0.0 || ^10.0.0`. Both major versions are supported, so a
consumer on either installs without an `overrides` entry.

`@eslint/js` stays pinned to `^9.39.1` as a direct dependency rather than
widening with the peer. That is deliberate: `@eslint/js@10` peer depends on
`eslint@^10`, so widening the range would let npm resolve it under an ESLint 9
consumer and reintroduce the conflict from the other direction. The version 9
package declares no peer dependencies at all, and the recommended rule set it
exports is consumed the same way by both linters, so one pin serves both.

`typescript-eslint` (`^8.46.0`) and `eslint-config-prettier` (`^10.1.8`) already
declare ranges that admit ESLint 10.
