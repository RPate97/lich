import { spawnSync } from 'node:child_process';

export function dockerOrSkip(): { available: true } | { available: false; reason: string } {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status === 0) return { available: true };
  return { available: false, reason: (r.stderr || r.stdout || 'docker not reachable').trim() };
}
