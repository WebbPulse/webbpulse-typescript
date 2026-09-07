import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries so the core stays framework free. An application that imports
  // only '@webbpulse/auth' never pulls React into its bundle.
  entry: ['src/index.ts', 'src/react.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
});
