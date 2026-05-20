/**
 * E2E harness — scaffold step.
 *
 * Spawns the real `@levelzero/create-stack-v0` binary into an OS tmpdir
 * subdir. The point is to exercise the same code path a user invokes via
 * `npx @levelzero/create-stack-v0 my-app`: name validation, template-root
 * resolution, `scaffoldStackV0`, and the printed next-steps message.
 *
 * Crucially, this scaffolds OUTSIDE the monorepo tree. The legacy smoke
 * test (`bin.plan14.smoke.e2e.test.ts`) scaffolds inside `packages/` so
 * bun's resolver walks up to the monorepo `node_modules/@levelzero/*`
 * symlinks — that bypasses the real `bun install` step and is precisely
 * the cheating mode LEV-198 was created to eliminate.
 *
 * The caller is expected to run `installDeps()` next to materialize the
 * `@levelzero/*` workspace overrides into real `node_modules` entries.
 */
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Located at `packages/core/tests/e2e/_helpers/scaffold.ts`. */
const HELPER_DIR = __dirname;

/** Resolves to `<repo>/packages/create-stack-v0/src/bin.ts`. */
export const CREATE_BIN = resolve(
  HELPER_DIR,
  '..',
  '..',
  '..',
  '..',
  'create-stack-v0',
  'src',
  'bin.ts',
);

/** Resolves to `<repo>/packages` — used by `installDeps` to enumerate workspace pkgs. */
export const REPO_PACKAGES_DIR = resolve(
  HELPER_DIR,
  '..',
  '..',
  '..',
  '..',
);

export interface ScaffoldOptions {
  /** Parent directory the new project will live in (must exist). */
  tmpdir: string;
  /** Project name passed to `create-stack-v0`. */
  projectName: string;
}

export interface ScaffoldResult {
  projectDir: string;
}

/**
 * Drive `@levelzero/create-stack-v0 <projectName>` with `tmpdir` as cwd.
 *
 * Throws with the captured stderr if the binary exits non-zero — the smoke
 * test setup needs an obvious failure mode (vitest swallows console errors
 * thrown deep in `beforeAll` otherwise).
 */
export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const { tmpdir, projectName } = opts;
  const r = spawnSync('bun', [CREATE_BIN, projectName], {
    cwd: tmpdir,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `create-stack-v0 failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  // realpathSync resolves macOS /var → /private/var so downstream
  // path-equality assertions don't trip on symlink expansion.
  const projectDir = realpathSync(join(tmpdir, projectName));
  return { projectDir };
}
