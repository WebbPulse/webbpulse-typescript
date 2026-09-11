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
    files: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
