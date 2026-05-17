import { spawn } from 'node:child_process';

/**
 * Typed wrapper around `docker compose -p <project> -f <file> <subcommand>`.
 *
 * Each method shells out to `docker compose` with the bound project name and
 * compose file. `ps`/`logs`/`exec` return parsed/captured output; `up`/`down`
 * throw on non-zero exit codes with stderr/stdout included in the message.
 */
export interface ComposeRunner {
  up(opts?: { detach?: boolean; waitForHealthy?: boolean }): Promise<void>;
  down(opts?: { volumes?: boolean }): Promise<void>;
  ps(): Promise<Array<{ name: string; state: string; ports: string[] }>>;
  logs(svc?: string, opts?: { since?: string; tail?: number }): Promise<string>;
  exec(svc: string, cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `docker compose` with the bound project/file prefix plus the given
 * subcommand arguments. Captures stdout/stderr and resolves with the exit
 * code; never rejects on non-zero exits — callers decide how to surface them.
 *
 * `timeoutMs` is enforced via SIGKILL; on timeout the promise rejects with
 * the full argv in the message for easier debugging.
 */
function runDockerCompose(
  baseArgs: string[],
  subArgs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const args = ['compose', ...baseArgs, ...subArgs];
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`docker ${args.join(' ')} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Shape of a single compose ps row in `--format json` output (Compose v2).
 * Only the fields we actually surface are declared; the real payload has
 * many more. `Publishers` may be null for services without ports.
 */
interface ComposePsJsonRow {
  Name?: string;
  Service?: string;
  State?: string;
  Publishers?: Array<{
    URL?: string;
    TargetPort?: number;
    PublishedPort?: number;
    Protocol?: string;
  }> | null;
}

/**
 * Format a single Publisher entry back into the familiar
 * `<host>:<published>-><target>/<proto>` string. Entries with no
 * PublishedPort (TargetPort only, no host binding) collapse to
 * `<target>/<proto>` to match `docker compose ps` text output.
 */
function formatPublisher(p: NonNullable<ComposePsJsonRow['Publishers']>[number]): string {
  const target = p.TargetPort ?? 0;
  const proto = p.Protocol ?? 'tcp';
  if (!p.PublishedPort || p.PublishedPort === 0) {
    return `${target}/${proto}`;
  }
  const host = p.URL && p.URL.length > 0 ? p.URL : '0.0.0.0';
  return `${host}:${p.PublishedPort}->${target}/${proto}`;
}

/**
 * Parse the NDJSON output of `docker compose ps --format json`. Compose
 * emits one JSON object per line (not a single array), so we split, trim,
 * and skip blank lines. Each row is normalised into `{ name, state, ports }`.
 */
function parsePs(stdout: string): Array<{ name: string; state: string; ports: string[] }> {
  const rows: Array<{ name: string; state: string; ports: string[] }> = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: ComposePsJsonRow;
    try {
      row = JSON.parse(trimmed) as ComposePsJsonRow;
    } catch {
      // Skip lines that aren't valid JSON; tolerates daemon warnings mixed in.
      continue;
    }
    const name = row.Name ?? row.Service ?? '';
    const state = row.State ?? '';
    const publishers = row.Publishers ?? [];
    const ports = publishers
      .filter((p) => p && typeof p === 'object')
      .map(formatPublisher);
    rows.push({ name, state, ports });
  }
  return rows;
}

export function makeComposeRunner(projectName: string, composeFile: string): ComposeRunner {
  const baseArgs = ['-p', projectName, '-f', composeFile];

  /**
   * Run a compose subcommand and throw if it exits non-zero. Used for `up`
   * and `down`, where the caller doesn't want the raw result — just success
   * or a descriptive error.
   */
  async function runOrThrow(subArgs: string[], timeoutMs: number): Promise<void> {
    const r = await runDockerCompose(baseArgs, subArgs, { timeoutMs });
    if (r.exitCode !== 0) {
      throw new Error(
        `docker compose ${subArgs.join(' ')} failed (exit ${r.exitCode})\n` +
          `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }
  }

  return {
    async up(opts = {}) {
      const args: string[] = ['up'];
      if (opts.detach ?? true) args.push('-d');
      if (opts.waitForHealthy) args.push('--wait');
      // 10min: image pulls + healthcheck waits can be slow on cold caches.
      await runOrThrow(args, 600_000);
    },

    async down(opts = {}) {
      const args: string[] = ['down'];
      if (opts.volumes) args.push('-v');
      await runOrThrow(args, 120_000);
    },

    async ps() {
      const r = await runDockerCompose(baseArgs, ['ps', '--format', 'json'], {
        timeoutMs: 30_000,
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `docker compose ps failed (exit ${r.exitCode})\n` +
            `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }
      return parsePs(r.stdout);
    },

    async logs(svc, opts = {}) {
      const args: string[] = ['logs', '--no-color'];
      if (opts.since) args.push('--since', opts.since);
      if (opts.tail !== undefined) args.push('--tail', String(opts.tail));
      if (svc) args.push(svc);
      const r = await runDockerCompose(baseArgs, args, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) {
        throw new Error(
          `docker compose logs failed (exit ${r.exitCode})\n` +
            `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }
      return r.stdout;
    },

    async exec(svc, cmd) {
      // `-T` disables pseudo-tty allocation — required when stdin isn't a tty,
      // which is always true here.
      const args = ['exec', '-T', svc, ...cmd];
      const r = await runDockerCompose(baseArgs, args, { timeoutMs: 60_000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
