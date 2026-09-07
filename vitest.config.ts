import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Node by default. Only the React bindings need a DOM, and jsdom costs
    // roughly an order of magnitude more per file to stand up, so it is opted
    // into per file rather than applied to the whole run.
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
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
