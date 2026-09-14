import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/react.ts', 'src/panels/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
});
