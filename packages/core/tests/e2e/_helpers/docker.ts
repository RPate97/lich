/**
 * E2E harness — docker helpers.
 *
 * Augments the existing `tests/_helpers/docker.ts` with a "can we actually
 * create networks" probe (catches address-pool exhaustion that
 * `docker info` alone misses — see LEV-120 / LEV-202), plus a
 * `dockerComposeDown` teardown helper used by the dogfood suite's
 * `afterAll`. Keeping this co-located with the e2e suite (rather than
 * under `tests/_helpers/`) so the e2e tier owns its own cleanup story.
 */
import { spawnSync } from 'node:child_process';
import { dockerOrSkip, dockerStackTeardown } from '../../_helpers/docker';

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
 * call even when no project exists. Used by the e2e suite's `afterAll`.
 *
 * LEV-202 — delegates to the shared `dockerStackTeardown` so the same
 * sweep-the-prefix logic the unit-test `withDockerStack` helper uses
 * applies here too. Catches networks compose silently left behind on
 * partial-up failures (image pull, healthcheck timeout). The `composeFile`
 * argument is preserved for source-compatibility with older callers but
 * ignored — `dockerStackTeardown` looks up the project's networks by name,
 * not by walking the compose file.
 */
export function dockerComposeDown(
  projectName: string,
  _composeFile?: string,
): void {
  dockerStackTeardown(projectName);
}

// Re-export the shared helper so e2e code that already imports from this
// module gets the same teardown semantics. Tests that need the full
// `withDockerStack(setup, body)` wrapper should import it from
// `../../_helpers/docker` directly.
export { dockerStackTeardown };
