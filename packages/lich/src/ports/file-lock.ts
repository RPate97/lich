/**
 * Cross-process file lock primitive.
 *
 * Acquisition is a write-to-tmp + link(2) atomic create: we write the
 * holder PID + acquired-at to a per-attempt tmpfile, then `link(tmp, lock)`
 * atomically materializes the lockfile WITH its metadata already in place.
 * POSIX guarantees `link` fails with EEXIST if the destination exists,
 * which is the mutual-exclusion primitive. Doing it this way (rather than
 * `open(wx)` followed by `writeFile`) eliminates the window where a
 * concurrent waiter could observe a freshly-created-but-empty lockfile
 * and reclaim it as "junk", letting two callers believe they hold the
 * lock simultaneously.
 *
 * Stale lockfiles (PID gone, or far past staleAfterMs) are reclaimed by
 * the next waiter so a SIGKILLed process can't deadlock the system.
 */

import {
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export class LockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`could not acquire lock for ${path} within ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
  }
}

export interface WithFileLockOptions {
  /** Maximum time to wait for the lock before throwing. Default 10s. */
  timeoutMs?: number;
  /**
   * Locks held by a dead PID for longer than this are considered stale
   * and reclaimed unconditionally on the first attempt. The PID-alive
   * probe ALSO triggers reclaim (and is the primary path); this knob
   * exists for symmetry with the spec and to bound the no-PID case if
   * someone hand-writes a zero-byte lockfile. Default 60s.
   */
  staleAfterMs?: number;
  /** Poll interval while waiting. Default 50ms. */
  pollMs?: number;
}

/**
 * `process.kill(pid, 0)` is the POSIX trick for "is this pid alive?" — it
 * sends no signal but throws ESRCH if the process is gone. EPERM means
 * the process exists but is owned by someone else: treat as alive (do
 * not steal). Anything else: treat as alive to be conservative.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockMeta {
  pid: number;
  acquiredAtMs: number;
}

async function readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Try JSON first (current format); fall back to plain-PID for
  // forward compatibility with older lockfiles.
  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.pid === "number" &&
      parsed.pid > 0
    ) {
      return {
        pid: parsed.pid,
        acquiredAtMs:
          typeof parsed.acquiredAtMs === "number" ? parsed.acquiredAtMs : 0,
      };
    }
  } catch {
    /* fall through to plain-PID */
  }
  const pid = Number(trimmed);
  if (Number.isFinite(pid) && pid > 0) return { pid, acquiredAtMs: 0 };
  return undefined;
}

async function reclaimIfStale(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  const meta = await readLockMeta(lockPath);
  if (meta === undefined) {
    // No readable metadata. Under the link(2) acquisition strategy this
    // CANNOT happen for an actively-held lock — link(2) makes the file
    // appear with content already in it. But a human (or a crashed-mid-
    // operation older lich) could leave a zero-byte file behind, so we
    // still handle it defensively. Require observing emptiness twice
    // across a 100ms gap before reclaiming, so we never steal a lock
    // because of an in-flight write from some other implementation.
    await new Promise((r) => setTimeout(r, 100));
    const meta2 = await readLockMeta(lockPath);
    if (meta2 !== undefined) return false;
    try {
      await unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  const isStale =
    !isPidAlive(meta.pid) ||
    (meta.acquiredAtMs > 0 && Date.now() - meta.acquiredAtMs > staleAfterMs);
  if (!isStale) return false;
  try {
    await unlink(lockPath);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `lich: reclaimed stale lock ${lockPath} (held by pid ${meta.pid})`,
  );
  return true;
}

/**
 * Atomic acquisition primitive. Writes metadata to a per-attempt tmpfile,
 * then `link(2)`s it to `lockPath`. POSIX guarantees `link` fails with
 * EEXIST if the destination already exists; success means we now hold
 * the lockfile AND it already contains our PID metadata (no observable
 * empty state). The tmpfile is always unlinked — its sole purpose is to
 * be the source of the atomic link.
 *
 * Returns true if we got the lock, false on EEXIST. Other errors propagate.
 */
async function tryAcquire(lockPath: string): Promise<boolean> {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(
    tmpPath,
    JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }),
    "utf8",
  );
  try {
    await link(tmpPath, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      await unlink(tmpPath);
    } catch {
      /* tmp is single-use; ignore failure */
    }
  }
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`. Spins with
 * backoff until the lock is acquired or `timeoutMs` elapses. The lock is
 * ALWAYS released (try/finally) by unlinking the lockfile, even if `fn`
 * throws.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: WithFileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const pollMs = opts.pollMs ?? 50;

  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let attemptedReclaim = false;
  let acquired = false;

  while (!acquired) {
    if (await tryAcquire(lockPath)) {
      acquired = true;
      break;
    }
    // EEXIST. Try a stale reclaim once, then poll until the deadline.
    if (!attemptedReclaim) {
      attemptedReclaim = true;
      if (await reclaimIfStale(lockPath, staleAfterMs)) continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
    await new Promise((res) => setTimeout(res, pollMs));
  }

  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      /* idempotent release */
    }
  }
}
