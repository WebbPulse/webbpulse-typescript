import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
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
