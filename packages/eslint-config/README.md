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
