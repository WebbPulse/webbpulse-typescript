import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';

/**
 * Points workspace imports at package source rather than dist, so the suite does
 * not depend on build output that does not exist on a clean tree.
 */
const WORKSPACE_SOURCE_ALIAS = {
  '@webbpulse/api-client': fileURLToPath(
    new URL('./packages/api-client/src/index.ts', import.meta.url)
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
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
      thresholds: {
        lines: 60,
        functions: 50,
        branches: 50,
        statements: 60,
      },
    },
  },
});
