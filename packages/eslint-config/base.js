import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for any TypeScript project, with the typed rules on.
 *
 * @param {object} [options]
 * @param {string[]} [options.project] tsconfig paths for the typed rules.
 * @param {string} [options.tsconfigRootDir] directory those paths resolve from.
 * @param {string[]} [options.files] override the files this block applies to.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function baseConfig(options = {}) {
  const {
    project = ['./tsconfig.json'],
    tsconfigRootDir = process.cwd(),
    files = ['**/*.ts', '**/*.tsx'],
  } = options;

  return tseslint.config(
    {
      ignores: ['dist/', 'node_modules/', 'coverage/', '**/*.d.ts'],
    },
    {
      files,
      extends: [
        js.configs.recommended,
        ...tseslint.configs.recommendedTypeChecked,
      ],
      languageOptions: {
        globals: {
          ...globals.browser,
          ...globals.es2021,
        },
        parserOptions: {
          project,
          tsconfigRootDir,
        },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
      },
    },
    {
      files: ['*.config.ts', '*.config.js', '*.config.mjs'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: {
        globals: { ...globals.node },
      },
    },
    prettier
  );
}

export default baseConfig;
