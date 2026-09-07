// Base flat config for any TypeScript project in the organisation.
//
// Type checked rules are on. CarModPicker already runs
// `recommendedTypeChecked` with the five `no-unsafe-*` rules promoted to
// errors; Portfolio runs untyped `recommended`. Converging on the stricter of
// the two is the point of sharing the config, so this is CarModPicker's level.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
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
        // Promoted from warn. An `any` that reaches production is a type hole
        // that the strict tsconfig cannot see, so lint is the only gate.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        // Underscore prefix is the escape hatch for a deliberately unused
        // binding, which destructuring to omit a key needs.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        // A floating promise in a browser is a silently swallowed failure.
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
      },
    },
    // Config files run in Node and sit outside the typed project.
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
