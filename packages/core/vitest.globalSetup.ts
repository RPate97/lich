/**
 * LEV-202 — Vitest globalSetup. Runs once per `vitest` invocation BEFORE
 * any test files are imported. Wired from both `vitest.config.ts` and
 * `vitest.e2e.config.ts`.
 *
 * Two responsibilities:
 *
 *   1. Stamp `process.env.TEST_RUN_ID` with a short, unique id (timestamp
 *      + 4 hex chars). Vitest's child workers inherit the parent's env,
 *      so every test in this run sees the same id. `compose/naming.ts`
 *      folds the id into every project/network/container/volume name
 *      (LEV-202 Layer 2), giving us a per-run namespace docker-side so:
 *
 *        a) sibling agents running tests in parallel can't trample each
 *           other (different ids → different names)
 *        b) the cleanup sweep can target THIS run's stacks via
 *           `docker network ls --filter name=lich-test-<id>-` instead
 *           of the global `lich-` namespace that would catch the
 *           user's real running stacks too
 *        c) the post-suite global `stacks prune --all` (Layer 3 sweep
 *           below) can still find them via the `lich-` prefix that
 *           every name still carries.
 *
 *   2. Pre-emptively sweep stale `lich-*` networks / containers /
 *      volumes left over from previous (crashed) test runs. Uses the
 *      existing `lich stacks prune --all --json` CLI, which already
 *      knows the safe-reap rules (skip running stacks that aren't ours,
 *      idempotent network rm, graceful when docker isn't installed).
 *
 *      Best-effort: any error here is swallowed with a `console.warn`.
 *      We never block test startup on the prune — a docker daemon outage
 *      shouldn't take the test suite down with it.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Generate a 12-char id matching `[a-z0-9-]{1,20}` (the validation regex
 * in `compose/naming.ts`). Format: `<6 hex base-36 chars from process
 * time><4 random hex chars>`. Short enough to keep docker identifiers
 * well under the 64-char limit even with the longest worktree key +
 * service suffix appended.
 */
function makeTestRunId(): string {
  const stamp = Date.now().toString(36).slice(-6);
  const rand = randomBytes(2).toString('hex');
  return `${stamp}${rand}`;
}

export default async function setup(): Promise<void> {
  // Stamp the id BEFORE any test imports `compose/naming.ts` so its
  // first call already picks up the prefix. We don't override a
  // pre-set value: the user (or an outer harness) may have already
  // picked an id they want every nested test process to share.
  if (!process.env.TEST_RUN_ID) {
    process.env.TEST_RUN_ID = makeTestRunId();
  }

  // Sweep prior leaks via the existing CLI machinery. Resolves to the
  // monorepo's `packages/core/src/bin.ts` regardless of which cwd vitest
  // was invoked from. Bun's resolver handles the TypeScript entry directly.
  const binPath = join(__dirname, 'src', 'bin.ts');
  try {
    const res = spawnSync(
      'bun',
      [binPath, 'stacks', 'prune', '--all', '--json'],
      {
        stdio: 'pipe',
        encoding: 'utf8',
        // 60s ceiling — prune does `docker rm -f` on every stale container,
        // which can take a few seconds each on a fleet of orphans. We'd
        // rather time out and keep running than block test startup
        // indefinitely on a hung docker daemon.
        timeout: 60_000,
      },
    );
    if (res.status !== 0) {
      // Don't fail — just log. The most common cause is docker not being
      // installed on the test host (the prune CLI itself reports
      // `dockerSkipped: true` in that case, which is fine).
      const detail = (res.stderr || res.stdout || '').trim().slice(0, 500);
      if (detail) {
        // eslint-disable-next-line no-console
        console.warn(
          `[vitest globalSetup] stacks prune --all exited ${res.status}: ${detail}`,
        );
      }
    }
  } catch (err) {
    // Spawn errors (ENOENT for bun, signal kill from timeout, etc.) are
    // ignored — Layer 1 (`withDockerStack`) and Layer 2 (TEST_RUN_ID
    // prefix) cover the in-run leak case; this sweep only addresses
    // legacy leaks across runs.
    // eslint-disable-next-line no-console
    console.warn(
      `[vitest globalSetup] stacks prune --all failed (continuing): ${
        (err as Error).message
      }`,
    );
  }
}
