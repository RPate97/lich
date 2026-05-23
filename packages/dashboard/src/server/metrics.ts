import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export interface StackMetrics {
  cpuPct?: number;  // aggregate %CPU across the stack's processes + containers, 0–100*N (N cores)
  memMB?: number;   // aggregate resident memory in MB
}

/**
 * Parse a Docker memory string like "123.4MiB", "1.2GiB", "500MB", "1.5GB"
 * and return the equivalent in MB. Returns undefined if unparseable.
 */
export function parseDockerMemMB(s: string): number | undefined {
  const m = s.trim().match(/^([\d.]+)\s*(MiB|MB|GiB|GB|KiB|KB)$/i);
  if (!m) return undefined;
  const val = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  if (unit === 'mib' || unit === 'mb') return val;
  if (unit === 'gib' || unit === 'gb') return val * 1024;
  if (unit === 'kib' || unit === 'kb') return val / 1024;
  return undefined;
}

/**
 * Run a command with a timeout. Resolves with stdout string or rejects on
 * error/timeout. The reject includes an AbortError-like on timeout.
 */
function execWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout as string);
      }
    });
    // Ensure the child is killed on timeout (execFile handles this via `timeout` option)
    void child;
  });
}

/**
 * Read pid files under <worktreePath>/.lich/state/<key>/pids/*.pid
 * and return the list of numeric pids.
 */
async function readOwnedPids(worktreePath: string, worktreeKey: string): Promise<number[]> {
  const pidsDir = join(worktreePath, '.lich', 'state', worktreeKey, 'pids');
  let files: string[];
  try {
    files = await readdir(pidsDir);
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const f of files) {
    if (!f.endsWith('.pid')) continue;
    try {
      const raw = await readFile(join(pidsDir, f), 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (!isNaN(pid) && pid > 0) pids.push(pid);
    } catch {
      // unreadable file — skip
    }
  }
  return pids;
}

/**
 * Sample CPU% and RSS for a list of pids via POSIX `ps`.
 * Returns { cpuPct, memMB } summed across all living pids.
 * Returns undefined for each metric if the list is empty or ps fails.
 */
async function samplePidMetrics(
  pids: number[],
): Promise<{ cpuPct: number; memMB: number } | undefined> {
  if (pids.length === 0) return undefined;

  const pidStr = pids.join(',');
  let stdout: string;
  try {
    // -o pid,%cpu,rss — rss is in KB on POSIX ps (macOS + Linux)
    stdout = await execWithTimeout('ps', ['-o', 'pid,%cpu,rss', '-p', pidStr], 5000);
  } catch {
    // ps fails if all pids are gone, or ps is unavailable
    return undefined;
  }

  let totalCpu = 0;
  let totalRssKB = 0;
  let found = false;

  const lines = stdout.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // Header line has PID,%CPU,RSS — all numeric check skips it
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0]!, 10);
    const cpu = parseFloat(parts[1]!);
    const rss = parseInt(parts[2]!, 10);
    if (isNaN(pid) || isNaN(cpu) || isNaN(rss)) continue;
    totalCpu += cpu;
    totalRssKB += rss;
    found = true;
  }

  if (!found) return undefined;
  return { cpuPct: totalCpu, memMB: totalRssKB / 1024 };
}

/**
 * Sample CPU% and memory from Docker containers via `docker stats --no-stream`.
 * Returns { cpuPct, memMB } summed, or undefined if docker is unavailable or
 * no containers are given. Capped at 2s to avoid hanging if docker is slow.
 */
async function sampleContainerMetrics(
  containers: string[],
): Promise<{ cpuPct: number; memMB: number } | undefined> {
  if (containers.length === 0) return undefined;

  let stdout: string;
  try {
    stdout = await execWithTimeout(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Container}} {{.CPUPerc}} {{.MemUsage}}', ...containers],
      2000,
    );
  } catch {
    // docker not installed, not running, or timed out
    return undefined;
  }

  let totalCpu = 0;
  let totalMemMB = 0;
  let found = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Format: <container_id_or_name> <cpu%> <used>/<limit>
    // Example: abc123 12.34% 123.4MiB / 2GiB
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    // parts[0] = container name/id
    // parts[1] = cpu% like "12.34%"
    // parts[2] = memory like "123.4MiB"
    // parts[3] = "/"
    // parts[4] = limit like "2GiB"

    const cpuStr = parts[1]!;
    const memUsedStr = parts[2]!;

    const cpu = parseFloat(cpuStr.replace('%', ''));
    const memMB = parseDockerMemMB(memUsedStr);

    if (isNaN(cpu)) continue;
    totalCpu += cpu;
    if (memMB !== undefined) totalMemMB += memMB;
    found = true;
  }

  if (!found) return undefined;
  return { cpuPct: totalCpu, memMB: totalMemMB };
}

/**
 * Sample aggregate CPU + memory for a stack. Reads pid files for owned processes
 * and queries docker for container metrics. Never throws — partial failures
 * return what data is available.
 *
 * Total sampling time is bounded: docker stats is capped at 2s; ps at 5s.
 * Both are run concurrently so the overall budget is ~2s.
 */
export async function sampleStackMetrics(
  worktreePath: string,
  worktreeKey: string,
  containers: string[],
): Promise<StackMetrics> {
  // Read pid files (fast, local fs)
  const pids = await readOwnedPids(worktreePath, worktreeKey);

  // Run ps and docker stats concurrently. Both are individually bounded.
  const [pidResult, containerResult] = await Promise.all([
    samplePidMetrics(pids).catch(() => undefined),
    sampleContainerMetrics(containers).catch(() => undefined),
  ]);

  let cpuPct: number | undefined;
  let memMB: number | undefined;

  if (pidResult !== undefined) {
    cpuPct = (cpuPct ?? 0) + pidResult.cpuPct;
    memMB = (memMB ?? 0) + pidResult.memMB;
  }
  if (containerResult !== undefined) {
    cpuPct = (cpuPct ?? 0) + containerResult.cpuPct;
    memMB = (memMB ?? 0) + containerResult.memMB;
  }

  const result: StackMetrics = {};
  if (cpuPct !== undefined) result.cpuPct = cpuPct;
  if (memMB !== undefined) result.memMB = memMB;
  return result;
}
