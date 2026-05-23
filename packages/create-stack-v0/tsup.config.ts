import { defineConfig } from 'tsup';

/**
 * `@lich/create-stack-v0` exposes both a library entry (`index.ts`) and a
 * CLI bin (`bin.ts`). The source `#!/usr/bin/env bun` shebang is preserved in
 * the built artifact: the scaffolded project it produces is a Bun-first
 * toolchain, and the sibling `lich` CLI it bootstraps requires Bun to
 * load `.ts` config files. `onSuccess` only marks the built bin executable.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
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
