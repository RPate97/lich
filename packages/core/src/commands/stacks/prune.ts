import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { LEVELZERO_PREFIX } from '../../compose/naming';
import type { Registry } from '../../registry';
import type { Command } from '../types';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a `docker` CLI command, capturing stdout/stderr. Never rejects on
 * non-zero exit codes — callers inspect `exitCode`. Rejects only when the
 * `docker` binary itself can't be spawned (ENOENT etc.) so the `--all`
 * sweep can degrade gracefully if docker isn't installed.
 *
 * Mirrors the inlined helper in `stop-all.ts` rather than importing it,
 * keeping the two prune/reap surfaces independent. Both inline copies exist
 * because the shared `src/docker/exec.ts` helper was deleted in LEV-134
 * along with the legacy non-compose runner.
 */
function dockerExec(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Probe `docker info` to decide whether the system-wide reap can run. We
 * call this once up-front rather than letting each `docker rm` call fail
 * individually — the user-facing message is clearer ("docker not available,
 * skipping container/network sweep") and we avoid pretending the sweep ran.
 */
async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await dockerExec(['info'], 10_000);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

async function listLevelzeroContainers(): Promise<string[]> {
  try {
    const r = await dockerExec(
      ['ps', '-a', '--filter', `name=${LEVELZERO_PREFIX}`, '--format', '{{.Names}}'],
      10_000,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
  } catch {
    return [];
  }
}

async function listLevelzeroNetworks(): Promise<string[]> {
  try {
    const r = await dockerExec(
      ['network', 'ls', '--filter', `name=${LEVELZERO_PREFIX}`, '--format', '{{.Name}}'],
      10_000,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
  } catch {
    return [];
  }
}

async function listLevelzeroVolumes(): Promise<string[]> {
  try {
    const r = await dockerExec(
      ['volume', 'ls', '--filter', `name=${LEVELZERO_PREFIX}`, '--format', '{{.Name}}'],
      10_000,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
  } catch {
    return [];
  }
}

async function removeContainer(name: string): Promise<boolean> {
  try {
    const r = await dockerExec(['rm', '-f', name], 30_000);
    return r.exitCode === 0 || r.stderr.includes('No such container');
  } catch {
    return false;
  }
}

async function removeNetwork(name: string): Promise<boolean> {
  try {
    const r = await dockerExec(['network', 'rm', name], 30_000);
    // `docker network rm` is idempotent enough — a missing network produces
    // "network ... not found" which we treat as success since the desired
    // post-condition (network gone) holds.
    return r.exitCode === 0 || r.stderr.includes('not found');
  } catch {
    return false;
  }
}

async function removeVolume(name: string): Promise<boolean> {
  try {
    const r = await dockerExec(['volume', 'rm', '-f', name], 30_000);
    return r.exitCode === 0 || r.stderr.includes('No such volume');
  } catch {
    return false;
  }
}

interface StackPruneResult {
  pruned: string[];
  containersRemoved?: string[];
  networksRemoved?: string[];
  volumesRemoved?: string[];
  dockerSkipped?: boolean;
}

/**
 * LEV-120 — extended with `--all` (and the more-destructive `--volumes`) to
 * recover from Docker address-pool exhaustion. The default behaviour is
 * unchanged: drop registry entries whose worktree path no longer exists.
 *
 * With `--all`:
 *   - sweep every `levelzero-*` container on the host (running or stopped)
 *   - sweep every `levelzero-*` network on the host (frees subnets from the
 *     default address pool — the root cause of "all predefined address pools
 *     have been fully subnetted")
 *
 * With `--all --volumes`, additionally remove every `levelzero-*` named
 * volume. Gated behind a second flag because volumes hold user data (e.g.
 * postgres bind-mount targets) and a single stale agent worktree shouldn't
 * silently wipe a developer's local DB state.
 */
export function makeStacksPruneCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.prune',
    describe:
      'Remove registry entries for worktrees that no longer exist; with --all, also reap stale levelzero-* containers and networks',
    async run(ctx) {
      const reg = getRegistry();
      const entries = await reg.list();
      const pruned: string[] = [];
      for (const { key, entry } of entries) {
        if (!(await pathExists(entry.path))) {
          await reg.remove(key);
          pruned.push(key);
        }
      }

      const all = Boolean(ctx.flags['all']);
      const includeVolumes = Boolean(ctx.flags['volumes']);

      let containersRemoved: string[] | undefined;
      let networksRemoved: string[] | undefined;
      let volumesRemoved: string[] | undefined;
      let dockerSkipped = false;

      if (all) {
        if (!(await dockerAvailable())) {
          dockerSkipped = true;
          containersRemoved = [];
          networksRemoved = [];
          if (includeVolumes) volumesRemoved = [];
        } else {
          // Reap containers first — networks can't be removed while a
          // container is still attached. We collect successes only, so a
          // network with a non-levelzero container attached is left alone
          // and reported as a remaining (non-removed) entry on the next run.
          containersRemoved = [];
          for (const cname of await listLevelzeroContainers()) {
            if (await removeContainer(cname)) containersRemoved.push(cname);
          }
          networksRemoved = [];
          for (const nname of await listLevelzeroNetworks()) {
            if (await removeNetwork(nname)) networksRemoved.push(nname);
          }
          if (includeVolumes) {
            volumesRemoved = [];
            for (const vname of await listLevelzeroVolumes()) {
              if (await removeVolume(vname)) volumesRemoved.push(vname);
            }
          }
        }
      }

      const result: StackPruneResult = { pruned };
      if (all) {
        result.containersRemoved = containersRemoved ?? [];
        result.networksRemoved = networksRemoved ?? [];
        if (includeVolumes) result.volumesRemoved = volumesRemoved ?? [];
        if (dockerSkipped) result.dockerSkipped = true;
      }

      if (ctx.format === 'json') return result;

      const lines: string[] = [];
      if (pruned.length === 0) {
        lines.push('no stale stacks to prune');
      } else {
        lines.push(`pruned ${pruned.length} stale stack(s):`);
        for (const key of pruned) lines.push(`  ${key}`);
      }
      if (all) {
        if (dockerSkipped) {
          lines.push('docker not available — skipped container/network sweep');
        } else {
          lines.push(
            `removed ${containersRemoved!.length} stale container(s)`,
          );
          for (const c of containersRemoved!) lines.push(`  ${c}`);
          lines.push(`removed ${networksRemoved!.length} stale network(s)`);
          for (const n of networksRemoved!) lines.push(`  ${n}`);
          if (includeVolumes) {
            lines.push(`removed ${volumesRemoved!.length} stale volume(s)`);
            for (const v of volumesRemoved!) lines.push(`  ${v}`);
          }
        }
      }
      return lines.join('\n') + '\n';
    },
  };
}
