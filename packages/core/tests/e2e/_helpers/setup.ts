/**
 * E2E harness — shared scaffold+install setup.
 *
 * LEV-198-extended split the dogfood suite into multiple per-surface
 * `.e2e.test.ts` files (lifecycle, env, db, codegen, ui, failure-surfaces).
 * Each file needs its own scaffolded project to assert against, but vitest's
 * `singleFork` mode means files share a process — so we want a tiny, stable
 * helper each `beforeAll` calls once with no duplicated wiring.
 *
 * This helper returns the same `{ tmpdir, projectDir }` shape `dogfood.e2e.
 * test.ts`'s inline scaffolder produced. Callers register their own
 * `afterAll(cleanup)` because cleanup ordering (stop → composeDown → rmtmp)
 * depends on what each suite ran. The `cleanup` factory returned here
 * handles the common case (no compose project to tear down) so most callers
 * just do `afterAll(cleanup)` and move on.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffoldProject } from './scaffold';
import { installDeps } from './install';
import { runCli } from './cli';
import { dockerComposeDown } from './docker';

export interface E2EProjectHandle {
  /** OS tmpdir holding the scaffolded project (and nothing else). */
  tmpdir: string;
  /** Absolute path to the scaffolded project. */
  projectDir: string;
  /**
   * Compose project name set by callers that ran `dev`. Filled in by the
   * test (post-scaffold), then read by the cleanup helper to tear down
   * the compose stack.
   */
  composeProjectName: string | null;
  /**
   * Mutate `composeProjectName`. Vitest's singleFork mode means the
   * top-level `let` from a test file IS shared with later files in the
   * same process, but we keep this helper-local so a stray cross-file
   * reference doesn't sneak in.
   */
  setComposeProjectName(name: string | null): void;
}

export interface SetupOptions {
  /** Project name passed to `create-stack-v0`. Defaults to `'demo'`. */
  projectName?: string;
  /**
   * Tmpdir prefix; helps when a suite is debugging which file scaffolded
   * which leaked directory. Defaults to `'lz-e2e-'`.
   */
  tmpdirPrefix?: string;
}

/**
 * Scaffold a fresh v0 project into an OS tmpdir, run `bun install` against
 * `file:` workspace overrides, and return a handle the suite can use.
 *
 * Costs ~30-60s on a warm bun cache. Each test FILE should call this once
 * in its `beforeAll` — DO NOT call it per-test (the suite would balloon to
 * 6+ minutes per file).
 */
export async function setupScaffoldedProject(
  opts: SetupOptions = {},
): Promise<E2EProjectHandle> {
  const projectName = opts.projectName ?? 'demo';
  const prefix = opts.tmpdirPrefix ?? 'lz-e2e-';
  const tmpdir = realpathSync(mkdtempSync(join(osTmpdir(), prefix)));
  const { projectDir } = await scaffoldProject({ tmpdir, projectName });
  await installDeps(projectDir);
  // Plain object — JS closures over `composeProjectName` would lose
  // referential mutation across helper boundaries. The setter pattern is
  // the cheapest workaround that keeps the field externally readable.
  const handle: E2EProjectHandle = {
    tmpdir,
    projectDir,
    composeProjectName: null,
    setComposeProjectName(name) {
      this.composeProjectName = name;
    },
  };
  return handle;
}

/**
 * Standardized cleanup for a scaffolded project. Best-effort, idempotent,
 * never throws — we'd rather leak a tmpdir than block vitest's shutdown.
 *
 * Order:
 *   1. `levelzero stop` from inside the project (releases the registry
 *      lock, kills owned host processes, sends compose-down).
 *   2. `docker compose down` against the captured project name (catches
 *      anything `stop` missed — e.g. when the test never reached `stop`).
 *   3. `rm -rf` the tmpdir.
 */
export async function teardownScaffoldedProject(
  handle: E2EProjectHandle,
): Promise<void> {
  try {
    if (handle.projectDir) {
      runCli(handle.projectDir, ['stop', '--json'], { timeoutMs: 30_000 });
    }
  } catch {
    /* stop is best-effort */
  }
  try {
    if (handle.composeProjectName) {
      dockerComposeDown(handle.composeProjectName);
    }
  } catch {
    /* compose down is best-effort */
  }
  try {
    if (handle.tmpdir) {
      rmSync(handle.tmpdir, { recursive: true, force: true });
    }
  } catch {
    /* tmpdir cleanup is best-effort — vitest's process exit may race */
  }
}
