// React flat config, layered on the base.
//
// The React plugins are peer dependencies rather than dependencies: the two
// applications are on different plugin sets today (CarModPicker adds react-x
// and react-dom on top of react-hooks and react-refresh, Portfolio runs only
// the latter two), and forcing the union on both from a shared package would
// make this config a blocker for whichever one is slower to adopt. A consumer
// passes the plugins it has.
import { baseConfig } from './base.js';

/**
 * @param {object} [options]
 * @param {string[]} [options.project] tsconfig paths for the typed rules.
 * @param {string} [options.tsconfigRootDir] directory those paths resolve from.
 * @param {Record<string, unknown>} [options.plugins] React plugins to register.
 * @param {Record<string, unknown>} [options.rules] extra rules to apply.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function reactConfig(options = {}) {
  const { plugins = {}, rules = {}, ...baseOptions } = options;

  return [
    ...baseConfig(baseOptions),
    {
      files: ['**/*.ts', '**/*.tsx'],
      ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
      rules: {
        ...('react-hooks' in plugins
          ? {
              'react-hooks/rules-of-hooks': 'error',
              'react-hooks/exhaustive-deps': 'warn',
            }
          : {}),
        ...('react-refresh' in plugins
          ? {
              'react-refresh/only-export-components': [
                'warn',
                { allowConstantExport: true },
              ],
            }
          : {}),
        ...rules,
      },
    },
  ];
}

export default reactConfig;
