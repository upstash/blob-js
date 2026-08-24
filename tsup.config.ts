import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', browser: 'src/browser/index.ts', react: 'src/react/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['react'],
  treeshake: true,
});
