import { defineConfig } from 'tsup';

/**
 * `@lich/plugin-prisma` ships ESM-only because the adapter uses
 * `createRequire(import.meta.url)` to resolve the bundled `prisma` CLI path —
 * `import.meta` doesn't exist in CJS, so a CJS build would silently break
 * Prisma command spawning. ESM-only is consistent with how the rest of the
 * Lich plugin surface is consumed (Node >= 20 + ESM).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
