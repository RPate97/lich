import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config';
import type { Registry } from '../registry';
import { findWorktree } from '../worktree';
import type { Command } from './types';

type Status = 'ok' | 'error' | 'skipped';
interface Check {
  id: string;
  status: Status;
  message?: string;
  version?: string;
}

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

export function makeDoctorCommand(getRegistry: () => Registry): Command {
  return {
    name: 'doctor',
    describe: 'Diagnose the local environment',
    async run(ctx) {
      const checks: Check[] = [];

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
      return { ok, checks };
    },
  };
}
