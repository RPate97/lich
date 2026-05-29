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

/** Read the dashboard URL the daemon recorded, or null if absent/empty. */
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
 * Poll until daemon advertises both `daemon.pid` and `daemon.url` AND the PID
 * is alive. Throws on timeout. The liveness check guards against stale files
 * left behind by a crashed daemon.
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

/** Poll until the PID file is gone OR the recorded PID is dead. Throws on timeout. */
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
