import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LEVELZERO_PREFIX } from '../compose/naming';
import { loadConfig } from '../config';
import {
  MIN_NODE_VERSION,
  formatNodeVersionError,
  isNodeVersionAtLeast,
} from '../node-version';
import type { Registry } from '../registry';
import { isPidAlive } from '../registry-lock';
import { findWorktree } from '../worktree';
import type { Command } from './types';

type Status = 'ok' | 'error' | 'skipped' | 'warn';
interface Check {
  id: string;
  status: Status;
  message?: string;
  version?: string;
}

/**
 * LEV-120 — warn when the local Docker daemon is approaching pool exhaustion
 * from stale `levelzero-*` networks. Default address pools typically support
 * only ~30 subnets; once exhausted, every `docker compose up` fails with
 * "all predefined address pools have been fully subnetted". 20 is a
 * conservative high-water mark that gives the developer time to run
 * `levelzero stacks prune --all` before things actually break.
 */
const NETWORK_WARN_THRESHOLD = 20;

/**
 * LEV-202 — warn when the daemon's `default-address-pools` configuration
 * only provides a small number of subnets. The default Docker install
 * ships pools that yield ~30 /16 subnets, which a single agent fleet can
 * exhaust in under an hour. We compute the total subnet capacity across
 * every pool entry (each `{ base, size }` contributes `2^(size - basePrefix)`
 * subnets); anything below this threshold trips the warning.
 *
 * 64 is the conservative cutoff: a typical agent run brings up 1-3
 * networks; 64 leaves room for ~20 concurrent runs before exhaustion
 * becomes a practical concern.
 */
const ADDRESS_POOL_WARN_THRESHOLD = 64;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `docker <args>`, buffering stdout/stderr. Resolves for any clean exit;
 * rejects only when the OS could not spawn docker at all (e.g. ENOENT when
 * docker isn't on PATH). Callers branch on `.code === 'ENOENT'` to treat that
 * as "docker not installed" rather than a real failure.
 */
function runDocker(args: string[]): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function checkDockerCompose(): Promise<Check> {
  let r: SpawnResult;
  try {
    r = await runDocker(['compose', 'version', '--format', 'json']);
  } catch (err) {
    // `docker` binary itself isn't on PATH (ENOENT) — skip cleanly. Other
    // spawn-time errors are rare; treat them the same way since the user can't
    // act on them from a compose check.
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id: 'docker-compose',
      status: 'skipped',
      message:
        code === 'ENOENT'
          ? 'docker is not installed or not on PATH'
          : `cannot run docker: ${(err as Error).message}`,
    };
  }

  if (r.exitCode !== 0) {
    // Most common cause is the compose plugin not being installed alongside
    // docker (e.g. `docker: 'compose' is not a docker command.`). Point the
    // user at the official install docs.
    const detail = (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`;
    return {
      id: 'docker-compose',
      status: 'error',
      message: `docker compose unavailable: ${detail} — see https://docs.docker.com/compose/install/`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    return {
      id: 'docker-compose',
      status: 'error',
      message: `failed to parse docker compose version JSON: ${(err as Error).message}`,
    };
  }

  const raw = (parsed as { version?: unknown })?.version;
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      id: 'docker-compose',
      status: 'error',
      message: `docker compose version JSON missing "version" field: ${r.stdout.slice(0, 200)}`,
    };
  }

  // `docker compose version --format json` reports e.g. "v2.30.3"; normalise
  // by stripping the leading "v" so downstream consumers get a bare semver.
  const version = raw.replace(/^v/, '');

  return { id: 'docker-compose', status: 'ok', version };
}

/**
 * Count live `levelzero-*` networks on the daemon and warn if we're close to
 * exhausting the default address pool. Skips cleanly when docker isn't on
 * PATH (the docker-compose check above will have already surfaced that).
 * A non-zero exit from `docker network ls` (e.g. daemon down) is also
 * treated as `skipped` — we don't want to make this check a hard failure
 * when the underlying signal isn't available.
 */
async function checkLevelzeroNetworks(): Promise<Check> {
  let r: SpawnResult;
  try {
    r = await runDocker([
      'network',
      'ls',
      '--filter',
      `name=${LEVELZERO_PREFIX}`,
      '--format',
      '{{.Name}}',
    ]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id: 'levelzero-networks',
      status: 'skipped',
      message:
        code === 'ENOENT'
          ? 'docker is not installed or not on PATH'
          : `cannot run docker: ${(err as Error).message}`,
    };
  }

  if (r.exitCode !== 0) {
    return {
      id: 'levelzero-networks',
      status: 'skipped',
      message: `docker network ls failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`,
    };
  }

  const names = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
  const count = names.length;

  if (count > NETWORK_WARN_THRESHOLD) {
    return {
      id: 'levelzero-networks',
      status: 'warn',
      message: `${count} levelzero-* networks detected (>${NETWORK_WARN_THRESHOLD}); docker may exhaust its default address pool. Run \`levelzero stacks prune --all\` to reclaim subnets.`,
    };
  }
  return { id: 'levelzero-networks', status: 'ok', message: `${count} network(s)` };
}

/**
 * LEV-202 — probe `docker info --format '{{json .DefaultAddressPools}}'`
 * and warn when the daemon's address-pool capacity is below
 * `ADDRESS_POOL_WARN_THRESHOLD`. Pure warning channel: never flips overall
 * `ok` to false. Skips cleanly when docker isn't on PATH (handled by the
 * upstream docker-compose check), when `docker info` exits non-zero, or
 * when the JSON parse fails (rare — older docker versions may not emit
 * the `DefaultAddressPools` field in the format we expect).
 *
 * Capacity formula: each pool entry has a `Base` CIDR (e.g. `172.17.0.0/16`)
 * and a `Size` (the prefix of each carved-out subnet, e.g. `24`). The
 * number of subnets per pool is `2^(Size - basePrefix)`. We sum across
 * every pool entry to get the total.
 */
async function checkDockerAddressPools(): Promise<Check> {
  let r: SpawnResult;
  try {
    r = await runDocker(['info', '--format', '{{json .DefaultAddressPools}}']);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id: 'docker-address-pools',
      status: 'skipped',
      message:
        code === 'ENOENT'
          ? 'docker is not installed or not on PATH'
          : `cannot run docker: ${(err as Error).message}`,
    };
  }

  if (r.exitCode !== 0) {
    return {
      id: 'docker-address-pools',
      status: 'skipped',
      message: `docker info failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`,
    };
  }

  // `docker info --format '{{json .DefaultAddressPools}}'` emits either
  // `null` (no pools configured — the daemon falls back to its compiled
  // defaults, ~30 subnets) or a JSON array like:
  //   [{"Base":"172.17.0.0/16","Size":16},{"Base":"192.168.0.0/16","Size":20}]
  // Note the capitalized field names — Go's encoder produces those.
  const trimmed = r.stdout.trim();
  if (trimmed === 'null') {
    return {
      id: 'docker-address-pools',
      status: 'warn',
      message:
        'docker has no custom default-address-pools configured; the built-in ~30-subnet default exhausts quickly under parallel agent loads. ' +
        recommendation(),
    };
  }
  if (!trimmed) {
    // Empty stdout — older docker versions may not surface the field at
    // all. Skip rather than warn so we don't pester users on platforms
    // where we can't make a confident assessment.
    return {
      id: 'docker-address-pools',
      status: 'skipped',
      message: 'docker info produced no DefaultAddressPools data',
    };
  }

  let pools: Array<{ Base?: unknown; Size?: unknown }>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return {
        id: 'docker-address-pools',
        status: 'skipped',
        message: `docker info DefaultAddressPools was not an array: ${trimmed.slice(0, 200)}`,
      };
    }
    pools = parsed;
  } catch (err) {
    return {
      id: 'docker-address-pools',
      status: 'skipped',
      message: `failed to parse docker info DefaultAddressPools: ${(err as Error).message}`,
    };
  }

  let totalSubnets = 0;
  for (const pool of pools) {
    const base = typeof pool.Base === 'string' ? pool.Base : undefined;
    const size = typeof pool.Size === 'number' ? pool.Size : undefined;
    if (!base || size === undefined) continue;
    const slash = base.lastIndexOf('/');
    if (slash < 0) continue;
    const basePrefix = Number(base.slice(slash + 1));
    if (!Number.isFinite(basePrefix) || basePrefix < 0 || basePrefix > 32) continue;
    if (size < basePrefix || size > 32) continue;
    // Each pool contributes 2^(size - basePrefix) subnets.
    totalSubnets += Math.pow(2, size - basePrefix);
  }

  if (totalSubnets < ADDRESS_POOL_WARN_THRESHOLD) {
    return {
      id: 'docker-address-pools',
      status: 'warn',
      message:
        `docker default-address-pools only provide ${totalSubnets} subnets ` +
        `(<${ADDRESS_POOL_WARN_THRESHOLD}); parallel agent runs may exhaust the pool. ` +
        recommendation(),
    };
  }

  return {
    id: 'docker-address-pools',
    status: 'ok',
    message: `${totalSubnets} subnets available across ${pools.length} pool(s)`,
  };
}

/**
 * The actionable fix text we surface in the warn message. Lives in one
 * place so test snapshots and operator-facing copy stay in sync.
 */
function recommendation(): string {
  return (
    'Edit `/etc/docker/daemon.json` and add:\n' +
    '  { "default-address-pools": [{ "base": "172.20.0.0/14", "size": 24 }] }\n' +
    'Then restart Docker. This yields 1024 subnets — a comfortable budget for parallel agent runs.'
  );
}

/**
 * Scan a directory for `.lock` files whose recorded PID is no longer
 * alive. The registry-lock writes its own PID into the lock file at
 * acquire time (LEV-199) — anything older (zero-byte legacy locks) or
 * with a dead PID is reportable as stale.
 *
 * Returns a `warn` if any stale locks are found, `ok` otherwise. Always
 * `ok` if the directory doesn't exist (no locks ever taken on this
 * host).
 */
async function checkStaleLocks(dir: string): Promise<Check> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { id: 'stale-locks', status: 'ok', message: '0 lock files' };
    }
    return {
      id: 'stale-locks',
      status: 'skipped',
      message: `cannot read ${dir}: ${(err as Error).message}`,
    };
  }

  const lockFiles = entries.filter((f) => f.endsWith('.lock'));
  if (lockFiles.length === 0) {
    return { id: 'stale-locks', status: 'ok', message: '0 lock files' };
  }

  const stale: Array<{ path: string; pid?: number }> = [];
  for (const f of lockFiles) {
    const p = join(dir, f);
    let pid: number | undefined;
    try {
      const raw = (await readFile(p, 'utf8')).trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) pid = n;
    } catch {
      /* unreadable lock file — treat as stale */
    }
    // No PID recorded (legacy or empty) → stale by definition. A PID
    // that doesn't probe alive → also stale.
    if (pid === undefined || !isPidAlive(pid)) {
      stale.push({ path: p, pid });
    }
  }

  if (stale.length === 0) {
    return {
      id: 'stale-locks',
      status: 'ok',
      message: `${lockFiles.length} lock file(s), all held by live processes`,
    };
  }

  const summary = stale
    .map((s) => (s.pid !== undefined ? `${s.path} (pid ${s.pid})` : `${s.path} (no pid)`))
    .join(', ');
  return {
    id: 'stale-locks',
    status: 'warn',
    message: `${stale.length} stale lock file(s): ${summary}. They will be reclaimed on next acquire, or remove manually.`,
  };
}

export function makeDoctorCommand(getRegistry: () => Registry): Command {
  return {
    name: 'doctor',
    describe: 'Diagnose the local environment',
    async run(ctx) {
      const checks: Check[] = [];

      // LEV-114 — Node version. In practice this won't ever fail inside `bin.ts`
      // because the startup gate would have exited the process already, but we
      // surface it here too so `levelzero doctor` reports an explicit "node:
      // ok (20.20.2)" line alongside the other infra checks, and so anyone
      // invoking the `doctor` command programmatically (e.g. tests, embedded
      // runners) still gets a structured signal.
      const nodeVersion = process.versions.node;
      if (isNodeVersionAtLeast(nodeVersion, MIN_NODE_VERSION)) {
        checks.push({ id: 'node', status: 'ok', version: nodeVersion });
      } else {
        checks.push({
          id: 'node',
          status: 'error',
          message: formatNodeVersionError(nodeVersion),
        });
      }

      // Registry directory writable
      const regPath = (getRegistry() as any).path as string;
      try {
        await mkdir(dirname(regPath), { recursive: true });
        await access(dirname(regPath));
        checks.push({ id: 'registry', status: 'ok' });
      } catch (err) {
        checks.push({
          id: 'registry',
          status: 'error',
          message: `cannot access registry dir ${dirname(regPath)}: ${(err as Error).message}`,
        });
      }

      // LEV-199 — stale lock detection. After a SIGKILL or crash where
      // the signal-handler cleanup never ran, the registry dir may
      // contain `.lock` files holding dead PIDs. Surface them as a
      // warning so the user can `rm` them (or let the next acquire
      // reclaim them on the fly).
      checks.push(await checkStaleLocks(dirname(regPath)));

      // Docker Compose availability
      checks.push(await checkDockerCompose());

      // LEV-120 — warn when stale levelzero-* networks are piling up. Pure
      // warning channel: never flips overall `ok` to false. The signal lets
      // a developer pre-empt the "all predefined address pools have been
      // fully subnetted" failure mode that hit Plan 14/15 era agent fleets.
      checks.push(await checkLevelzeroNetworks());

      // LEV-202 — warn when docker's default-address-pools are sized for
      // the ~30-subnet default; that's where agent fleets hit pool
      // exhaustion before the stale-network sweep can keep up. Same warn
      // channel as `levelzero-networks` — never blocks `doctor: ok`.
      checks.push(await checkDockerAddressPools());

      // Worktree presence
      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        checks.push({ id: 'project', status: 'skipped', message: 'not inside a levelzero project' });
      } else {
        checks.push({ id: 'project', status: 'ok', message: wt.path });
        // Config loadable
        try {
          await loadConfig(wt.configPath);
          checks.push({ id: 'config', status: 'ok' });
        } catch (err) {
          checks.push({ id: 'config', status: 'error', message: (err as Error).message });
        }
      }

      const ok = checks.every((c) => c.status !== 'error');
      const out = { ok, checks };
      if (ctx.format === 'json') return out;
      const lines: string[] = [];
      for (const c of checks) {
        const marker =
          c.status === 'ok'
            ? '[OK]'
            : c.status === 'skipped'
              ? '[SKIP]'
              : c.status === 'warn'
                ? '[WARN]'
                : '[FAIL]';
        const detail = c.message
          ? ` — ${c.message}`
          : c.version
            ? ` (${c.version})`
            : '';
        lines.push(`${marker} ${c.id}${detail}`);
      }
      lines.push('');
      lines.push(ok ? 'doctor: ok' : 'doctor: failed');
      return lines.join('\n') + '\n';
    },
  };
}
