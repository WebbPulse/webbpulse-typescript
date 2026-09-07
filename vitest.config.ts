import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects rather than environmentMatchGlobs, which vitest 3
    // deprecates. The split is the same: jsdom costs roughly an order of
    // magnitude more per file to stand up, and only the React bindings need a
    // DOM, so the rest of the suite stays on node.
    projects: [
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
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
