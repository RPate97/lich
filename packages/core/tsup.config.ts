import { defineConfig } from 'tsup';

/**
 * tsup build for `@levelzero/core` (LEV-214).
 *
 * Entries mirror the published `exports` map in package.json — every subpath
 * the map advertises must have a corresponding entry here, otherwise external
 * consumers that import `@levelzero/core/<subpath>` will fail after install.
 *
 * `bin.ts` is included so the published `levelzero` CLI binary points at a
 * built artifact instead of raw TS source. The source `#!/usr/bin/env bun`
 * shebang is intentionally preserved: the CLI loads project `levelzero.config.ts`
 * files via dynamic `import()`, which requires a runtime that imports TypeScript
 * natively (Bun). `onSuccess` only marks the built bin executable.
 *
 * `skipNodeModulesBundle` keeps `pg`, `prisma`, `ts-morph`, etc. external —
 * those are runtime dependencies that should resolve from the consumer's
 * node_modules, not be inlined into the artifact.
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/errors.ts',
    'src/registry.ts',
    'src/worktree.ts',
    'src/services/context.ts',
    'src/services/types.ts',
    'src/commands/dev.ts',
    'src/compose/naming.ts',
    'src/adapters/registry.ts',
    'src/adapters/portless/types.ts',
    'src/env/registry.ts',
    'src/bin.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  skipNodeModulesBundle: true,
  onSuccess: async () => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const distDir = join(process.cwd(), 'dist');
    for (const file of ['bin.js', 'bin.cjs']) {
      const path = join(distDir, file);
      try {
        await fs.chmod(path, 0o755);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  },
});
