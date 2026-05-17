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
