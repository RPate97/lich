import { defineConfig } from 'tsup';

/**
 * Builds the dashboard SERVER only (src/server → dist/server). The SPA is
 * built separately by Vite (`vite build` → dist/web); the package `build`
 * script runs Vite first, then tsup. `skipNodeModulesBundle` keeps React etc.
 * out of the server bundle — the server never imports them.
 */
export default defineConfig({
  entry: ['src/server/index.ts'],
  outDir: 'dist/server',
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  skipNodeModulesBundle: true,
});
