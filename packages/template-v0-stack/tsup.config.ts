import { defineConfig } from 'tsup';

/**
 * `@lich/template-v0-stack` ships ESM-only because it relies on
 * `import.meta.url` to resolve the bundled `files/` directory at runtime —
 * CJS doesn't expose `import.meta`, so a CJS build would silently produce a
 * broken `templateRoot`. Both internal callers (`@lich/core init`,
 * `@lich/create-stack-v0`) run under Node >= 20 with ESM resolution, so
 * dropping CJS here is safe.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
