import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `process.kill(pid, 0)` is the POSIX trick for "is this pid alive?" — it sends
 * no signal but throws ESRCH if the process is gone. We use it to wait out
 * SIGTERM gracefully before escalating to SIGKILL so well-behaved services
 * get a chance to flush logs / shut down workers.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every `<service>.pid` file from the detached state dir, deliver
 * SIGTERM, wait briefly, then SIGKILL anything still alive. The pid file is
 * removed once the process is confirmed dead so a stale file doesn't trip
 * the next `dev`/`stop`/`restart` cycle.
 *
 * Missing pid dir is a no-op — `--live` `dev` doesn't write pid files, and
 * a stack that's already been stopped won't have any to clean up.
 *
 * Returns the list of services we acted on so callers can include them in
 * a teardown summary.
 *
 * Extracted from `stop.ts` (LEV-249) so both `stop` and `restart` can
 * reuse the same logic without duplicating the SIGTERM/SIGKILL escalation.
 */
export async function signalDetachedOwned(pidDir: string): Promise<
  Array<{ name: string; pid: number; result: 'terminated' | 'killed' | 'stale' }>
> {
  let entries: string[];
  try {
    entries = await readdir(pidDir);
  } catch {
    return [];
  }

  const pidFiles = entries.filter((f) => f.endsWith('.pid'));
  const records: Array<{
    name: string;
    pid: number;
    path: string;
  }> = [];

  for (const f of pidFiles) {
    const path = join(pidDir, f);
    const raw = (await readFile(path, 'utf8')).trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      // Empty or malformed — just delete it so the dir doesn't grow stale.
      await rm(path, { force: true });
      continue;
    }
    records.push({ name: f.replace(/\.pid$/, ''), pid, path });
  }

  const results: Array<{
    name: string;
    pid: number;
    result: 'terminated' | 'killed' | 'stale';
  }> = [];

  // First pass: SIGTERM every live pid.
  for (const r of records) {
    if (!isAlive(r.pid)) {
      await rm(r.path, { force: true });
      results.push({ name: r.name, pid: r.pid, result: 'stale' });
      continue;
    }
    try {
      process.kill(r.pid, 'SIGTERM');
    } catch {
      /* already gone between isAlive and kill — fine */
    }
  }

  // Wait up to ~2s for graceful exit.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const stillAlive = records.filter(
      (r) =>
        !results.some((x) => x.name === r.name) && isAlive(r.pid),
    );
    if (stillAlive.length === 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }

  // Second pass: escalate to SIGKILL for anyone who didn't shut down, then
  // remove the pid file for everything we acted on.
  for (const r of records) {
    if (results.some((x) => x.name === r.name)) continue;
    if (isAlive(r.pid)) {
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {
        /* race; either way, the file goes */
      }
      results.push({ name: r.name, pid: r.pid, result: 'killed' });
    } else {
      results.push({ name: r.name, pid: r.pid, result: 'terminated' });
    }
    await rm(r.path, { force: true });
  }

  return results;
}
