import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PidFileOpts {
  lichHome?: string;
}

function pidFilePath(opts?: PidFileOpts): string {
  return resolveLichHomeFile(opts, "daemon.pid");
}

function urlFilePath(opts?: PidFileOpts): string {
  return resolveLichHomeFile(opts, "daemon.url");
}

function proxyUrlFilePath(opts?: PidFileOpts): string {
  return resolveLichHomeFile(opts, "daemon.proxy-url");
}

// resolution: explicit opts → $LICH_HOME → ~/.lich
function resolveLichHomeFile(
  opts: PidFileOpts | undefined,
  filename: string,
): string {
  if (opts?.lichHome && opts.lichHome.length > 0) {
    return join(opts.lichHome, filename);
  }
  const override = process.env.LICH_HOME;
  if (override && override.length > 0) {
    return join(override, filename);
  }
  return join(homedir(), ".lich", filename);
}

/** Write the daemon's PID atomically (write to tmp then rename) so concurrent readers never see a partial file. */
export async function writeDaemonPid(
  pid: number,
  opts?: PidFileOpts,
): Promise<void> {
  const dest = pidFilePath(opts);
  await mkdir(dirname(dest), { recursive: true });

  const serialized = `${pid}\n`;
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Returns the parsed PID, or null if the file is absent or its contents aren't a positive integer. */
export async function readDaemonPid(
  opts?: PidFileOpts,
): Promise<number | null> {
  const path = pidFilePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Number() (not parseInt) so "123abc" is rejected.
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return pid;
}

/** Returns true when the recorded PID corresponds to a live process (cannot detect PID-reuse collisions). */
export async function isDaemonAlive(opts?: PidFileOpts): Promise<boolean> {
  const pid = await readDaemonPid(opts);
  if (pid === null) return false;

  try {
    // signal 0 = existence check; EPERM (exists but not ours) counts as alive
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Idempotent — succeeds silently when the file is already absent. */
export async function clearDaemonPid(opts?: PidFileOpts): Promise<void> {
  const path = pidFilePath(opts);
  await rm(path, { force: true });
}

/** Write the daemon's dashboard URL atomically (same write-tmp-then-rename pattern as the PID file). */
export async function writeDaemonUrl(
  url: string,
  opts?: PidFileOpts,
): Promise<void> {
  const dest = urlFilePath(opts);
  await mkdir(dirname(dest), { recursive: true });

  const serialized = `${url}\n`;
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Returns the trimmed URL, or null if the file is absent or empty. */
export async function readDaemonUrl(
  opts?: PidFileOpts,
): Promise<string | null> {
  const path = urlFilePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Idempotent — succeeds silently when the file is already absent. */
export async function clearDaemonUrl(opts?: PidFileOpts): Promise<void> {
  const path = urlFilePath(opts);
  await rm(path, { force: true });
}

/** Write the friendly proxy URL atomically; written BEFORE `daemon.url` so consumers can use that as the readiness signal. */
export async function writeDaemonProxyUrl(
  url: string,
  opts?: PidFileOpts,
): Promise<void> {
  const dest = proxyUrlFilePath(opts);
  await mkdir(dirname(dest), { recursive: true });

  const serialized = `${url}\n`;
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Returns the trimmed friendly proxy URL, or null if the file is absent or empty. */
export async function readDaemonProxyUrl(
  opts?: PidFileOpts,
): Promise<string | null> {
  const path = proxyUrlFilePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Idempotent — succeeds silently when the file is already absent. */
export async function clearDaemonProxyUrl(opts?: PidFileOpts): Promise<void> {
  const path = proxyUrlFilePath(opts);
  await rm(path, { force: true });
}
