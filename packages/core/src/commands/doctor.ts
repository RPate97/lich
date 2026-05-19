import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LEVELZERO_PREFIX } from '../compose/naming';
import { loadConfig } from '../config';
import {
  MIN_NODE_VERSION,
  formatNodeVersionError,
  isNodeVersionAtLeast,
} from '../node-version';
import type { Registry } from '../registry';
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

      // Docker Compose availability
      checks.push(await checkDockerCompose());

      // LEV-120 — warn when stale levelzero-* networks are piling up. Pure
      // warning channel: never flips overall `ok` to false. The signal lets
      // a developer pre-empt the "all predefined address pools have been
      // fully subnetted" failure mode that hit Plan 14/15 era agent fleets.
      checks.push(await checkLevelzeroNetworks());

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
