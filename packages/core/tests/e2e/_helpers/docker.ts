/**
 * E2E harness — docker helpers.
 *
 * Augments the existing `tests/_helpers/docker.ts` with:
 *   - A "can we actually create networks" probe (catches address-pool
 *     exhaustion that `docker info` alone misses — see LEV-120 / LEV-202).
 *   - `withDockerStack`: a try/finally wrapper that guarantees a
 *     `docker compose down --volumes` regardless of how the body exits.
 *     Mirrors the LEV-202 cleanup pattern; lives here so the new e2e
 *     suite has the helper available even before LEV-202 lands as a
 *     core feature.
 *
 * Keeping this co-located with the e2e suite (rather than under
 * `tests/_helpers/`) so the e2e tier owns its own cleanup story —
 * `withDockerStack` calls `docker compose down`, which is exactly what
 * the legacy smoke test does NOT do (it leaks containers when assertions
 * fail mid-test).
 */
import { spawnSync } from 'node:child_process';
import {
  dockerOrSkip,
  isContainerRunning,
} from '../../_helpers/docker';

export { dockerOrSkip, isContainerRunning };

/**
 * Returns true iff:
 *   1. `docker info` succeeds (daemon reachable, user has permission), AND
 *   2. We can create-then-delete a throwaway network (address pool not
 *      exhausted).
 *
 * The second probe matters because long-running developer machines
 * routinely accumulate orphaned `levelzero-*` networks until
 * `docker network create` fails with
 * `all predefined address pools have been fully subnetted` — at which
 * point `docker info` still happily reports green.
 *
 * Call this once at module load (it informs `describe.skipIf` predicates,
 * which vitest evaluates at file-parse time).
 */
export function dockerAvailable(): boolean {
  const status = dockerOrSkip();
  if (!status.available) return false;
  const name = `lz-e2e-probe-${process.pid}-${Date.now()}`;
  const create = spawnSync('docker', ['network', 'create', name], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (create.status !== 0) return false;
  spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  return true;
}

/**
 * Best-effort `docker compose down` for a project. Idempotent — safe to
 * call even when no project exists. Used by the e2e suite's `afterAll`
 * and (transitively) by `withDockerStack`.
 *
 * Why `--timeout 5`: the default compose timeout is 10s per container,
 * and a hung container can stretch teardown well past the test's
 * `afterAll` deadline. 5s is enough for postgres and friends to flush
 * a transaction log; anything that takes longer than that, we accept
 * a SIGKILL on.
 */
export function dockerComposeDown(
  projectName: string,
  composeFile?: string,
): void {
  const args = ['compose', '-p', projectName];
  if (composeFile) args.push('-f', composeFile);
  args.push('down', '--volumes', '--remove-orphans', '--timeout', '5');
  spawnSync('docker', args, { stdio: 'pipe', encoding: 'utf8' });
  // `docker compose down` does NOT remove the project network (it persists
  // for the next `up`). For test cleanup we want to free the address-pool
  // slot too; `docker network rm` is idempotent (errors silently if the
  // network doesn't exist), so this is safe regardless.
  spawnSync('docker', ['network', 'rm', `${projectName}_default`], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/**
 * Wrap an async body in a try/finally that guarantees
 * `docker compose down` runs against `projectName`. If the body throws,
 * the original error is re-thrown after teardown.
 *
 * Useful in tests that bring up a stack mid-test and need to clean up
 * before the next assertion runs (vs. relying on `afterAll`, which only
 * fires at the end of the whole suite).
 */
export async function withDockerStack<T>(
  projectName: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    try {
      dockerComposeDown(projectName);
    } catch {
      // Teardown is best-effort. If `docker compose down` itself fails
      // (rare; usually because the project never came up), we'd rather
      // surface the body's original error than this one.
    }
  }
}
