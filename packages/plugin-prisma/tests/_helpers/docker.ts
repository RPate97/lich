import { spawnSync } from 'node:child_process';

/**
 * Probe whether `docker info` succeeds in the current environment. Tests that
 * need a live Docker daemon call this and switch to `describe.skip` when it
 * returns `available: false` — same shape used by the equivalent helper in
 * `@lich/core` so suites can guard integration code paths without
 * crashing in CI machines that have no Docker.
 */
export function dockerOrSkip(): { available: true } | { available: false; reason: string } {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status === 0) return { available: true };
  return { available: false, reason: (r.stderr || r.stdout || 'docker not reachable').trim() };
}
