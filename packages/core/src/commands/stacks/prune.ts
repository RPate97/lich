import { spawn } from 'node:child_process';
import { access, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * Outcome classifications for a single owned-service pid file scanned during
 * `--all`. Mirrors the vocabulary used by `stop.ts` (`terminated`/`killed`/
 * `stale`) and adds `'skipped'` for the "process is alive AND looks legitimate"
 * case where the user didn't pass `--force` — we leave the pid file alone so
 * the running stack isn't yanked out from under them.
 */
type ReapResult =
  | 'stale' // file referenced a pid that's already dead — file removed
  | 'orphan' // worktree gone but pid file lingered — file removed (process may have been alive)
  | 'terminated' // SIGTERM was sufficient
  | 'killed' // had to escalate to SIGKILL
  | 'skipped' // alive process belonging to a still-existing worktree, no --force
  | 'foreign' // EPERM from process.kill — pid exists but isn't ours; left alone
  | 'invalid'; // malformed pid file — removed

interface ReapedProcess {
  worktreeKey: string;
  service: string;
  pid: number;
  result: ReapResult;
}

/**
 * `process.kill(pid, 0)` is the POSIX trick for "is this pid alive?" — it
 * sends no signal but throws ESRCH if the process is gone, or EPERM if the
 * pid exists but we don't own it. Distinguishing the two matters here: ESRCH
 * means safe to remove the stale pid file; EPERM means a pid was recycled by
 * an unrelated process and we MUST NOT signal it.
 *
 * Mirrors the helper in `stop.ts`; kept inline rather than shared because
 * that helper collapses both errors into a single boolean and we need the
 * distinction for the reap-vs-skip decision.
 */
function probePid(pid: number): 'alive' | 'dead' | 'foreign' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return 'foreign';
    return 'dead';
  }
}

async function isAliveAfterDelay(pid: number, ms: number): Promise<boolean> {
  await new Promise((res) => setTimeout(res, ms));
  return probePid(pid) === 'alive';
}

/**
 * Walk every pid file under `<worktreePath>/.levelzero/state/<worktreeKey>/pids/`
 * and reap as appropriate.
 *
 * Decision matrix (matches the LEV-201 spec):
 *   - pid file is empty / NaN          → remove file, result=`invalid`
 *   - probe → `dead`                   → remove file, result=`stale`
 *   - probe → `foreign` (EPERM)        → leave file, result=`foreign`
 *     (we can't prove it's ours, so refuse to kill or delete the marker)
 *   - probe → `alive`, worktree gone   → SIGTERM/SIGKILL, remove file, result=`orphan`
 *   - probe → `alive`, worktree exists, `force=true`   → SIGTERM/SIGKILL, remove file, result=`terminated`/`killed`
 *   - probe → `alive`, worktree exists, `force=false`  → leave both, result=`skipped`
 *     (the stack is presumed legitimately running; `--force` is the escape hatch)
 */
async function reapPidsForEntry(
  worktreeKey: string,
  worktreePath: string,
  worktreeExists: boolean,
  force: boolean,
): Promise<ReapedProcess[]> {
  const pidDir = join(worktreePath, '.levelzero', 'state', worktreeKey, 'pids');

  let entries: string[];
  try {
    entries = await readdir(pidDir);
  } catch {
    // No pid dir = no detached services were ever spawned for this worktree,
    // or `stop` already cleaned them up. Nothing to do.
    return [];
  }

  const reaped: ReapedProcess[] = [];
  const pidFiles = entries.filter((f) => f.endsWith('.pid'));

  // First pass: classify each file and send SIGTERM where appropriate.
  type Pending = {
    service: string;
    pid: number;
    path: string;
    treatAsStale: boolean;
  };
  const pending: Pending[] = [];

  for (const f of pidFiles) {
    const path = join(pidDir, f);
    const service = f.replace(/\.pid$/, '');
    let raw: string;
    try {
      raw = (await readFile(path, 'utf8')).trim();
    } catch {
      continue;
    }
    if (raw.length === 0) {
      await rm(path, { force: true });
      reaped.push({ worktreeKey, service, pid: Number.NaN, result: 'invalid' });
      continue;
    }
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      await rm(path, { force: true });
      reaped.push({ worktreeKey, service, pid, result: 'invalid' });
      continue;
    }

    const probe = probePid(pid);
    if (probe === 'dead') {
      await rm(path, { force: true });
      reaped.push({ worktreeKey, service, pid, result: 'stale' });
      continue;
    }
    if (probe === 'foreign') {
      // Pid exists but isn't ours — recycled, almost certainly an unrelated
      // system process. Refuse to touch it; leave the file so a human can
      // investigate rather than silently hide the evidence.
      reaped.push({ worktreeKey, service, pid, result: 'foreign' });
      continue;
    }

    // probe === 'alive'
    const treatAsStale = !worktreeExists || force;
    if (!treatAsStale) {
      reaped.push({ worktreeKey, service, pid, result: 'skipped' });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* race — already exited; the SIGKILL phase will see it as dead */
    }
    pending.push({ service, pid, path, treatAsStale: true });
  }

  // Wait briefly for graceful exits to land, then escalate.
  if (pending.length > 0) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const stillAlive = pending.filter((p) => probePid(p.pid) === 'alive');
      if (stillAlive.length === 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    for (const p of pending) {
      if (probePid(p.pid) === 'alive') {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          /* lost the race — file goes either way */
        }
        // Give the OS a brief moment to reap so a follow-up `stacks list`
        // doesn't race on the still-visible pid. We don't gate the
        // `'killed'` classification on the result — once SIGKILL was
        // delivered, the kernel will reap on its own schedule.
        await isAliveAfterDelay(p.pid, 50);
        await rm(p.path, { force: true });
        reaped.push({
          worktreeKey,
          service: p.service,
          pid: p.pid,
          result: 'killed',
        });
      } else {
        await rm(p.path, { force: true });
        reaped.push({
          worktreeKey,
          service: p.service,
          pid: p.pid,
          result: worktreeExists ? 'terminated' : 'orphan',
        });
      }
    }
  }

  return reaped;
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
  /**
   * LEV-201 — per-pid-file outcomes from the orphan owned-service reap.
   * Present only on `--all`. Entries always include the pid file we
   * inspected (even when we left it alone), so the operator can tell
   * "nothing to do" from "skipped because alive without --force".
   */
  reapedProcesses?: ReapedProcess[];
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
      'Remove registry entries for worktrees that no longer exist; with --all, also reap stale levelzero-* containers, networks, and orphan owned-service processes (use --force to kill alive processes whose worktree still exists)',
    async run(ctx) {
      const reg = getRegistry();
      const entries = await reg.list();

      // Snapshot of (key, path, exists) BEFORE we mutate the registry. The
      // --all reap path needs to know which worktrees were stale at the
      // moment the prune started so it can classify pid-file outcomes
      // correctly. We can't recompute this after the prune loop because
      // `reg.remove` has already dropped the stale entries.
      const snapshot = await Promise.all(
        entries.map(async ({ key, entry }) => ({
          key,
          path: entry.path,
          exists: await pathExists(entry.path),
        })),
      );

      const pruned: string[] = [];
      for (const s of snapshot) {
        if (!s.exists) {
          await reg.remove(s.key);
          pruned.push(s.key);
        }
      }

      const all = Boolean(ctx.flags['all']);
      const includeVolumes = Boolean(ctx.flags['volumes']);
      const force = Boolean(ctx.flags['force']);

      let containersRemoved: string[] | undefined;
      let networksRemoved: string[] | undefined;
      let volumesRemoved: string[] | undefined;
      let dockerSkipped = false;
      let reapedProcesses: ReapedProcess[] | undefined;

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

        // Reap orphan owned-service host processes (LEV-201). Independent of
        // docker availability — pid files are on the local filesystem and
        // host processes survive docker outages. Run sequentially per
        // worktree so signal/wait/escalate timings don't race each other.
        reapedProcesses = [];
        for (const s of snapshot) {
          const found = await reapPidsForEntry(s.key, s.path, s.exists, force);
          reapedProcesses.push(...found);
        }
      }

      const result: StackPruneResult = { pruned };
      if (all) {
        result.containersRemoved = containersRemoved ?? [];
        result.networksRemoved = networksRemoved ?? [];
        if (includeVolumes) result.volumesRemoved = volumesRemoved ?? [];
        if (dockerSkipped) result.dockerSkipped = true;
        result.reapedProcesses = reapedProcesses ?? [];
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
        // Pretty-print the pid-file outcomes. Group by category so the
        // common case (everything quiet) renders as a single line.
        const reaped = reapedProcesses ?? [];
        const reapedCount = reaped.filter(
          (r) =>
            r.result === 'terminated' ||
            r.result === 'killed' ||
            r.result === 'orphan' ||
            r.result === 'stale' ||
            r.result === 'invalid',
        ).length;
        const skipped = reaped.filter((r) => r.result === 'skipped');
        const foreign = reaped.filter((r) => r.result === 'foreign');
        lines.push(`reaped ${reapedCount} orphan owned-service pid file(s)`);
        for (const r of reaped) {
          if (
            r.result === 'terminated' ||
            r.result === 'killed' ||
            r.result === 'orphan' ||
            r.result === 'stale' ||
            r.result === 'invalid'
          ) {
            lines.push(
              `  ${r.worktreeKey}/${r.service} (pid ${r.pid}) — ${r.result}`,
            );
          }
        }
        if (skipped.length > 0) {
          lines.push(
            `skipped ${skipped.length} alive process(es) — pass --force to kill:`,
          );
          for (const r of skipped) {
            lines.push(`  ${r.worktreeKey}/${r.service} (pid ${r.pid})`);
          }
        }
        if (foreign.length > 0) {
          lines.push(
            `${foreign.length} pid file(s) reference foreign processes (EPERM) — left alone:`,
          );
          for (const r of foreign) {
            lines.push(`  ${r.worktreeKey}/${r.service} (pid ${r.pid})`);
          }
        }
      }
      return lines.join('\n') + '\n';
    },
  };
}
