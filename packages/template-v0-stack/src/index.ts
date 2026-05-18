import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `@levelzero/template-v0-stack` — the v0 stack template shipped with the
 * levelzero CLI.
 *
 * The package bundles the scaffolded file tree under `./files/` and exposes
 * the absolute path to that directory as `templateRoot`. The `levelzero init
 * <name>` command (from `@levelzero/core`) reads `templateRoot` and hands it
 * to `copyTemplate(...)` to materialize a fresh v0 project.
 *
 * The same export is consumed by the future `@levelzero/create-stack-v0` npx
 * wrapper (see LEV-159) so both entry points scaffold from identical files.
 *
 * Resolution uses `import.meta.url` so the path is correct regardless of
 * whether the package is loaded via a workspace symlink, a published tarball,
 * or a bundled artifact.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the directory containing the v0 stack template files.
 */
export const templateRoot: string = resolve(here, '..', 'files');
