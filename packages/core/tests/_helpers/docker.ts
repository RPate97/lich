import { spawnSync } from 'node:child_process';

export function dockerOrSkip(): { available: true } | { available: false; reason: string } {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status === 0) return { available: true };
  return { available: false, reason: (r.stderr || r.stdout || 'docker not reachable').trim() };
}

/**
 * Synchronous probe for `docker inspect -f '{{.State.Running}}' <name>`.
 * Returns true only when the container exists and is running. Used by
 * integration tests that need to assert post-compose-down teardown.
 *
 * Lives here (rather than in `src/`) because production code uses
 * `docker compose ps` for state queries; this is purely a test affordance
 * for inspecting individual containers by their compose-assigned name.
 */
export function isContainerRunning(name: string): boolean {
  const r = spawnSync(
    'docker',
    ['inspect', '-f', '{{.State.Running}}', name],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  return r.status === 0 && (r.stdout || '').trim() === 'true';
}

/**
 * LEV-202 — best-effort teardown for a single compose project. Idempotent,
 * never throws. The two-step sequence catches both the common case (compose
 * removes its own network) AND the partial-up failure case where compose
 * created the network but never finished bringing services up, so `down`
 * with the same `-p` still finds and removes it.
 *
 * Belt-and-suspenders: after the compose down, we sweep any `docker network
 * ls` results whose name starts with the project name. This catches:
 *   - `<project>_default` (compose's auto-created network)
 *   - Any user-declared networks compose attached to the project
 *   - Stragglers from a `compose up` that crashed between network create
 *     and service create
 *
 * Why timeout 5s: the default compose timeout is 10s per container, and a
 * hung container can stretch teardown well past a test's `afterAll`
 * deadline. 5s is enough for postgres and friends to flush a transaction
 * log; anything that takes longer we accept a SIGKILL on.
 */
export function dockerStackTeardown(projectName: string): void {
  try {
    spawnSync(
      'docker',
      [
        'compose',
        '-p',
        projectName,
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        '5',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    /* best-effort */
  }
  // Belt-and-suspenders network sweep — compose may have missed networks
  // it didn't fully wire up (image pull failure, healthcheck timeout etc).
  // We list networks whose name matches the project prefix, then remove
  // each one individually. Each `network rm` is idempotent — a missing
  // network produces "not found" which we ignore.
  try {
    const ls = spawnSync(
      'docker',
      ['network', 'ls', '--filter', `name=${projectName}`, '--format', '{{.Name}}'],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    if (ls.status === 0) {
      const names = (ls.stdout || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.startsWith(projectName));
      for (const name of names) {
        try {
          spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * LEV-202 — wrap a test body so docker stacks are torn down even when the
 * body throws or never reaches its own cleanup. The teardown runs in a
 * `finally`, so SIGINT/timeout-driven aborts that vitest catches still
 * trigger it. SIGKILL on the test process itself can't be caught — that's
 * what Layer 3's `globalSetup` sweep covers on the *next* run.
 *
 * Usage:
 *   it('foo', async () => {
 *     await withDockerStack({ projectName: composeProjectName(key) }, async () => {
 *       // body that does `docker compose up`, may throw
 *     });
 *   });
 *
 * Or, for tests that already have their own teardown logic, call
 * `dockerStackTeardown(projectName)` directly from the `finally` block.
 *
 * Compose project name MUST be derived from `composeProjectName()` so the
 * TEST_RUN_ID prefix (Layer 2) flows through and the sweep stays scoped
 * to this test run's stacks.
 */
export async function withDockerStack<T>(
  setup: { projectName: string },
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    dockerStackTeardown(setup.projectName);
  }
}
