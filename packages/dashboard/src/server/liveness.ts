import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ServiceStatus } from '../types';

const execFileAsync = promisify(execFile);

/** How long a freshly-spawned service gets before a probe failure becomes `unhealthy`. */
export const STARTUP_GRACE_MS = 10_000;

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

/**
 * HTTP healthcheck probe. Returns:
 *  - `'ok'`          — 2xx or 3xx response
 *  - `'fail'`        — 4xx or 5xx response
 *  - `'unreachable'` — connection error, timeout, or any other throw
 *
 * Never throws; always resolves.
 */
export async function probeUrl(
  url: string,
  timeoutMs = 1000,
): Promise<'ok' | 'fail' | 'unreachable'> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 400 ? 'ok' : 'fail';
  } catch {
    return 'unreachable';
  }
}

/**
 * Derive a `ServiceStatus` for a process-backed service given:
 *  - `alive`     — result of `isPidAlive(pid)`
 *  - `probeResult` — result of `probeUrl(url)` if a URL was provided, else `null`
 *  - `createdAt` — ISO timestamp from the registry entry (grace window anchor)
 *  - `now`       — current epoch-ms (injectable for tests)
 */
export function deriveOwnedStatus(
  alive: boolean,
  probeResult: 'ok' | 'fail' | 'unreachable' | null,
  createdAt: string,
  now: number,
): ServiceStatus {
  if (!alive) return 'down';
  if (probeResult === null) return 'healthy'; // alive but no URL to probe
  if (probeResult === 'ok') return 'healthy';
  // probe not passing — check grace window
  const spawnedAt = new Date(createdAt).getTime();
  const withinGrace = now - spawnedAt < STARTUP_GRACE_MS;
  if (withinGrace) return 'starting';
  // After grace: explicit fail → unhealthy; unreachable (service not yet listening) → unhealthy
  return 'unhealthy';
}

/** One owned service discovered from its pid file. */
export interface OwnedServiceLiveness {
  name: string;
  status: ServiceStatus;
}

/** Context passed to `readOwnedServices` for probe + grace logic. */
export interface OwnedServicesContext {
  /** URL map from the registry entry — keyed by service name. */
  urls: Record<string, string>;
  /** ISO creation timestamp of the stack (grace window anchor). */
  createdAt: string;
  /** Current epoch-ms; defaults to `Date.now()` when omitted. */
  now?: number;
}

/**
 * Discover owned (host-process) services for a stack by reading the
 * `<service>.pid` files the detached `dev` runner writes to
 * `<worktreePath>/.lich/state/<worktreeKey>/pids/`. Each file's status is
 * derived from pid liveness + an optional HTTP probe. A missing dir → no owned
 * services (returns []).
 */
export async function readOwnedServices(
  worktreePath: string,
  worktreeKey: string,
  ctx: OwnedServicesContext = { urls: {}, createdAt: new Date(0).toISOString() },
): Promise<OwnedServiceLiveness[]> {
  const pidsDir = join(worktreePath, '.lich', 'state', worktreeKey, 'pids');
  let files: string[];
  try {
    files = await readdir(pidsDir);
  } catch {
    return [];
  }
  const now = ctx.now ?? Date.now();
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
    const alive = isPidAlive(pid);
    const url = ctx.urls[name];
    let probeResult: 'ok' | 'fail' | 'unreachable' | null = null;
    if (alive && url) {
      probeResult = await probeUrl(url);
    }
    out.push({ name, status: deriveOwnedStatus(alive, probeResult, ctx.createdAt, now) });
  }
  return out;
}

/**
 * Context passed to `readContainerLiveness` for docker-health integration.
 * (Currently unused; reserved for future per-container probe context.)
 */
export interface ContainerLivenessContext {
  /** Current epoch-ms; defaults to `Date.now()` when omitted. */
  now?: number;
}

/**
 * Derive a `ServiceStatus` from docker inspect fields.
 *  - `running` — whether `.State.Running` is `true`
 *  - `health`  — `.State.Health.Status` when present: `'healthy' | 'unhealthy' | 'starting'`
 *                When absent (no HEALTHCHECK defined), falls back to running-only check.
 */
export function deriveContainerStatus(
  running: boolean,
  health: string | null,
): ServiceStatus {
  if (!running) return 'down';
  if (health === null) return 'healthy'; // no docker HEALTHCHECK → running == healthy
  if (health === 'healthy') return 'healthy';
  if (health === 'starting') return 'starting';
  // 'unhealthy' | 'exited' | anything else
  return 'unhealthy';
}

/**
 * Liveness for a set of docker containers. One `docker inspect` call covers
 * all names; a container that is absent or not running maps to `'down'`. If
 * the docker CLI is unavailable entirely, every container reports `'down'`
 * (the dashboard is best-effort — it never blocks on docker).
 *
 * Reads `.State.Health.Status` when present so containers with a defined
 * HEALTHCHECK reflect `healthy` / `unhealthy` / `starting` rather than just
 * running/not-running.
 */
export async function readContainerLiveness(
  containers: string[],
  _ctx: ContainerLivenessContext = {},
): Promise<Record<string, ServiceStatus>> {
  const result: Record<string, ServiceStatus> = {};
  for (const c of containers) result[c] = 'down';
  if (containers.length === 0) return result;
  try {
    // Format: "<name> <running> <healthStatus_or_none>"
    // .State.Health.Status is empty string when no HEALTHCHECK is defined.
    const { stdout } = await execFileAsync(
      'docker',
      [
        'inspect',
        '--format',
        '{{.Name}} {{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        ...containers,
      ],
      { timeout: 5000 },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // `.Name` comes back with a leading slash, e.g. `/proj-postgres-1`.
      const parts = trimmed.split(/\s+/);
      const rawName = parts[0] ?? '';
      const running = parts[1] === 'true';
      const healthRaw = parts[2] ?? 'none';
      const health = healthRaw === 'none' ? null : healthRaw;
      const name = rawName.replace(/^\//, '');
      if (name in result) {
        result[name] = deriveContainerStatus(running, health);
      }
    }
  } catch {
    /* docker missing / inspect failed → leave all 'down' */
  }
  return result;
}
