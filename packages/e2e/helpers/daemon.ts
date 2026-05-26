/**
 * E2e helpers for waiting on the lich daemon's lifecycle (Plan 5 Task 20).
 *
 * The daemon advertises itself on disk via two files under `<LICH_HOME>`:
 *   - `daemon.pid` — the daemon process ID (written atomically; see
 *     `packages/lich/src/daemon/pid-file.ts`).
 *   - `daemon.url` — the dashboard URL (e.g. `http://127.0.0.1:<port>`).
 *
 * Plan 5 e2e tests need to assert "the daemon is up" or "the daemon has
 * shut down" without coupling to the daemon's IPC. These helpers poll
 * the on-disk advertisement and use `process.kill(pid, 0)` (signal 0 =
 * existence check) to confirm liveness — same approach as
 * `isDaemonAlive()` in `pid-file.ts`, but synchronous-from-the-test's
 * perspective via a poll loop with a deadline.
 *
 * Why poll instead of fs.watch? Polling is dead simple, portable, and
 * matches the timing requirements (the daemon writes both files within
 * ~500ms of starting; a 100ms poll catches it cleanly). fs.watch has
 * platform quirks (macOS coalesces, Linux fires before fsync) that
 * would add complexity for no measurable speed win at this granularity.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DaemonInfo {
  pid: number;
  url: string;
}

export interface WaitForDaemonOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_INTERVAL = 100;

/**
 * Read the dashboard URL the daemon recorded, or null if absent/empty.
 *
 * Synchronous because callers tend to use this in assertions after a
 * `waitForDaemonRunning` has already resolved (so the file is guaranteed
 * to be present and stable).
 */
export function readDaemonUrl(lichHome: string): string | null {
  const path = join(lichHome, "daemon.url");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read the daemon's PID from disk, or null if absent/malformed.
 *
 * Synchronous companion to `readDaemonUrl`. Mirrors the parsing rules
 * in `packages/lich/src/daemon/pid-file.ts`: integer-only, positive.
 */
function readDaemonPidSync(lichHome: string): number | null {
  const path = join(lichHome, "daemon.pid");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Signal-0 liveness probe. Returns true if the PID corresponds to a
 * running process (or one we lack permission to signal — counts as
 * alive per `isDaemonAlive`'s semantics).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Poll until the daemon advertises itself via both `daemon.pid` AND
 * `daemon.url` AND the recorded PID is alive. Returns `{ pid, url }`
 * on success; throws on timeout.
 *
 * The "PID alive" check guards against the corner case where a daemon
 * crashed mid-startup, leaving stale files behind — the next `lich up`
 * needs to spawn a fresh daemon, not believe the corpse.
 */
export async function waitForDaemonRunning(
  lichHome: string,
  opts: WaitForDaemonOptions = {},
): Promise<DaemonInfo> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pid = readDaemonPidSync(lichHome);
    const url = readDaemonUrl(lichHome);
    if (pid !== null && url !== null && isPidAlive(pid)) {
      return { pid, url };
    }
    await sleep(interval);
  }

  throw new Error(
    `timeout waiting for daemon to start in ${lichHome} after ${timeout}ms`,
  );
}

/**
 * Poll until the daemon is no longer running. Resolves when either:
 *   - The PID file is gone (clean shutdown cleared it), OR
 *   - The PID file exists but the recorded PID is dead (the daemon
 *     crashed without cleanup).
 *
 * Throws on timeout — i.e. the PID file persists AND the recorded PID
 * is still alive past the deadline.
 */
export async function waitForDaemonStopped(
  lichHome: string,
  opts: WaitForDaemonOptions = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pid = readDaemonPidSync(lichHome);
    if (pid === null) return;
    if (!isPidAlive(pid)) return;
    await sleep(interval);
  }

  throw new Error(
    `timeout waiting for daemon to stop in ${lichHome} after ${timeout}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
