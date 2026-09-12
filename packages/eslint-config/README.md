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

## Prettier settings

`./prettier` publishes the estate's canonical Prettier options, so every consumer
formats identically instead of drifting in its own `.prettierrc`. Point the
consumer's config file at the export rather than copying the values:

```json
"@webbpulse/eslint-config/prettier"
```

That is the entire contents of a consumer `.prettierrc.json`. Prettier resolves a
string config file as a module reference, so the options arrive from this package
and a change here reaches every consumer on its next version bump.

`arrowParens` is `"always"`. It was the value this repository already used, and it
is Prettier's own default, so it is the setting a new consumer lands on when it
has no config at all.

To override one option for a single consumer, use the object form and spread the
shared config through `extends` instead:

```json
{ "extends": "@webbpulse/eslint-config/prettier", "printWidth": 100 }
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
