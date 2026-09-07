import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';

/**
 * Points workspace imports at package source rather than dist.
 *
 * The auth suite imports @webbpulse/api-client, and the published exports map
 * deliberately offers only dist to anything outside this repository. CI runs
 * the tests before the build, so without this the suite would depend on build
 * output that does not exist yet on a clean tree.
 */
const WORKSPACE_SOURCE_ALIAS = {
  '@webbpulse/api-client': fileURLToPath(
    new URL('./packages/api-client/src/index.ts', import.meta.url)
  ),
};

export default defineConfig({
  test: {
    // Two projects rather than environmentMatchGlobs, which vitest 3
    // deprecates. The split is the same: jsdom costs roughly an order of
    // magnitude more per file to stand up, and only the React bindings need a
    // DOM, so the rest of the suite stays on node.
    projects: [
      {
        // Resolves @webbpulse/api-client to its source, so the auth suite runs
        // against a clean tree with no dist. CI runs the tests before the
        // build, so without this the run depends on build output that is not
        // there yet. Matches the customConditions in the package tsconfigs.
        resolve: { alias: WORKSPACE_SOURCE_ALIAS },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: WORKSPACE_SOURCE_ALIAS },
        test: {
          name: 'dom',
          globals: true,
          environment: 'jsdom',
          include: ['packages/*/src/**/*.test.tsx'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/index.ts',
        '**/dist/**',
        '**/*.config.ts',
      ],
      // Thresholds match CarModPicker's frontend, which is the only side of
      // the estate with an enforced floor today.
      thresholds: {
        lines: 60,
        functions: 50,
        branches: 50,
        statements: 60,
      },
    },
  },
});
