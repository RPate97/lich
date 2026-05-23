/**
 * E2E harness — scaffold step.
 *
 * Spawns the real `@lich/create-stack-v0` binary into an OS tmpdir
 * subdir. The point is to exercise the same code path a user invokes via
 * `npx @lich/create-stack-v0 my-app`: name validation, template-root
 * resolution, `scaffoldStackV0`, and the printed next-steps message.
 *
 * Crucially, this scaffolds OUTSIDE the monorepo tree. The legacy smoke
 * test (`bin.plan14.smoke.e2e.test.ts`) scaffolds inside `packages/` so
 * bun's resolver walks up to the monorepo `node_modules/@lich/*`
 * symlinks — that bypasses the real `bun install` step and is precisely
 * the cheating mode LEV-198 was created to eliminate.
 *
 * The caller is expected to run `installDeps()` next to materialize the
 * `@lich/*` workspace overrides into real `node_modules` entries.
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
  /**
   * Combined stdout from the scaffold step. LEV-198-extended routes around
   * `create-stack-v0`'s bin and calls `copyTemplate` directly via a small
   * `bun -e` stub, so this is whatever `copyTemplate` emits (currently
   * nothing — it doesn't print). Returned so callers can still assert on
   * "the scaffolder emitted X" if/when output is added.
   */
  stdout: string;
}

/**
 * Names that survive this regex are safe to join into a tmpdir path without
 * worrying about traversal (`../etc`) or shell-meaningful characters. We
 * deliberately disallow leading `.` so callers can't scaffold into a hidden
 * directory by accident either. Mirrors the `create-stack-v0` name validator
 * conceptually but is purposefully duplicated here so the harness has its
 * own first line of defense.
 */
const SAFE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/** Resolves to `<repo>/packages/template-v0-stack/files` — pinned to THIS worktree. */
const WORKTREE_TEMPLATE_DIR = resolve(
  HELPER_DIR,
  '..',
  '..',
  '..',
  '..',
  'template-v0-stack',
  'files',
);

/**
 * Materialize this worktree's v0 template into `<tmpdir>/<projectName>`.
 *
 * We bypass `create-stack-v0`'s bin entirely and invoke this worktree's
 * `copyTemplate` directly with the worktree-pinned `WORKTREE_TEMPLATE_DIR`.
 * Why not the bin: `create-stack-v0/src/bin.ts` resolves
 * `@lich/template-v0-stack` via node_modules at the top of the file,
 * and in a git-worktree setup that symlink chains up to the MAIN repo —
 * a different tree that can ship envInjection keys (e.g. `hono.port`,
 * `next.port` from LEV-200) the plugins in THIS worktree don't contribute.
 * The mismatch surfaces as a load-time `EnvSourceMissingError` from
 * `bootPlugins`, failing every CLI invocation downstream — including
 * `lich --help`. Pinning the template AND the `copyTemplate`
 * implementation to absolute paths in our worktree closes that gap.
 *
 * Throws with the captured stderr if the spawn exits non-zero — the smoke
 * test setup needs an obvious failure mode (vitest swallows console errors
 * thrown deep in `beforeAll` otherwise).
 */
export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const { tmpdir, projectName } = opts;
  // First-line defense against a test passing `'../etc'` or shell-meaningful
  // characters. The tmpdir join would otherwise escape `tmpdir`, and the
  // subsequent rm-rf in teardown could nuke things outside the harness's
  // jurisdiction. See M16 in LEV-206.
  if (!SAFE_PROJECT_NAME.test(projectName)) {
    throw new Error(
      `scaffoldProject: invalid projectName ${JSON.stringify(projectName)} ` +
        `(must match ${SAFE_PROJECT_NAME})`,
    );
  }
  // We resolve THIS worktree's `copyTemplate` source explicitly (not via
  // `@lich/core` from node_modules — the workspace symlink would
  // surface a different worktree's implementation). The stub script
  // imports `copyTemplate` by absolute file path so bun's resolver can't
  // route around it.
  const copyTemplateSrc = resolve(
    HELPER_DIR,
    '..',
    '..',
    '..',
    'src',
    'scaffolder.ts',
  );
  const stubBody = `
import { copyTemplate } from ${JSON.stringify(copyTemplateSrc)};
await copyTemplate({
  from: ${JSON.stringify(WORKTREE_TEMPLATE_DIR)},
  to: ${JSON.stringify(join(tmpdir, projectName))},
  vars: { projectName: ${JSON.stringify(projectName)} },
});
`;
  const r = spawnSync('bun', ['-e', stubBody], {
    cwd: tmpdir,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `worktree-pinned copyTemplate failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  // realpathSync resolves macOS /var → /private/var so downstream
  // path-equality assertions don't trip on symlink expansion.
  const projectDir = realpathSync(join(tmpdir, projectName));
  return { projectDir, stdout: r.stdout ?? '' };
}
