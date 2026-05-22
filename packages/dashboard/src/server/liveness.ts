import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ServiceStatus } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Liveness probe for a host process. `process.kill(pid, 0)` sends no signal —
 * it only checks whether the pid is signalable (alive + permitted). `ESRCH`
 * means dead; `EPERM` means alive but owned by another user (still "up").
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One owned service discovered from its pid file. */
export interface OwnedServiceLiveness {
  name: string;
  status: ServiceStatus;
}

/**
 * Discover owned (host-process) services for a stack by reading the
 * `<service>.pid` files the detached `dev` runner writes to
 * `<worktreePath>/.levelzero/state/<worktreeKey>/pids/`. Each file's status is
 * derived from pid liveness. A missing dir → no owned services (returns []).
 */
export async function readOwnedServices(
  worktreePath: string,
  worktreeKey: string,
): Promise<OwnedServiceLiveness[]> {
  const pidsDir = join(worktreePath, '.levelzero', 'state', worktreeKey, 'pids');
  let files: string[];
  try {
    files = await readdir(pidsDir);
  } catch {
    return [];
  }
  const out: OwnedServiceLiveness[] = [];
  for (const f of files) {
    if (!f.endsWith('.pid')) continue;
    const name = f.replace(/\.pid$/, '');
    let pid = Number.NaN;
    try {
      pid = Number.parseInt((await readFile(join(pidsDir, f), 'utf8')).trim(), 10);
    } catch {
      /* unreadable → treat as dead */
    }
    out.push({ name, status: isPidAlive(pid) ? 'up' : 'down' });
  }
  return out;
}

/**
 * Liveness for a set of docker containers. One `docker inspect` call covers
 * all names; a container that is absent or not running maps to `'down'`. If
 * the docker CLI is unavailable entirely, every container reports `'down'`
 * (the dashboard is best-effort — it never blocks on docker).
 */
export async function readContainerLiveness(
  containers: string[],
): Promise<Record<string, ServiceStatus>> {
  const result: Record<string, ServiceStatus> = {};
  for (const c of containers) result[c] = 'down';
  if (containers.length === 0) return result;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.Name}} {{.State.Running}}', ...containers],
      { timeout: 5000 },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // `.Name` comes back with a leading slash, e.g. `/proj-postgres-1`.
      const [rawName, running] = trimmed.split(/\s+/);
      const name = (rawName ?? '').replace(/^\//, '');
      if (name in result && running === 'true') result[name] = 'up';
    }
  } catch {
    /* docker missing / inspect failed → leave all 'down' */
  }
  return result;
}
