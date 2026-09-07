// Root lint config. Dogfoods @webbpulse/eslint-config against this repository's
// own packages, so a regression in the shared config fails this repository's CI
// before it reaches an application.
import { baseConfig } from './packages/eslint-config/base.js';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/eslint-config/**',
      'packages/tsconfig/**',
    ],
  },
  ...baseConfig({
    project: ['./tsconfig.eslint.json'],
    tsconfigRootDir: import.meta.dirname,
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
  }),
  {
    // Tests assert on error paths and deliberately pass malformed values, so
    // the unsafe-* family is noise there rather than signal.
    files: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
