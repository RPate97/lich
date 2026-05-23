import {
  open,
  unlink,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { addCleanup } from './signal-handlers';

export class LockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`could not acquire lock for ${path} within ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

export interface AcquireLockOptions {
  /** Total time to wait before throwing. Default: 30s. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default: 20ms. */
  pollMs?: number;
}

/**
 * Set of lock paths currently held by THIS process. The signal-handler
 * cleanup (registered lazily on first acquire) walks this set and
 * synchronously unlinks every entry — that's the LEV-199 fix path. The
 * happy-path `release()` returned from `acquireLock` also removes its
 * entry from the set so the signal-handler doesn't try to unlink a file
 * we've already cleaned up.
 *
 * Exported (deliberately undocumented in `index.ts`) so tests can assert
 * the bookkeeping is correct.
 */
export const activeLockPaths = new Set<string>();

let signalCleanupRegistered = false;

/**
 * Test-only: reset module-level state so tests can run in isolation.
 * Not exported from `index.ts`. Production code should never call this.
 */
export function __resetRegistryLockForTest(): void {
  activeLockPaths.clear();
  signalCleanupRegistered = false;
}

/**
 * Synchronously unlink every lock file we still hold. Runs from the
 * shared signal-handler module on SIGINT/SIGTERM. Synchronous because
 * Node's event loop is about to terminate — there's no time to await
 * promises, and `fsPromises.unlink` may not even flush before
 * `process.exit` fires.
 */
function releaseAllLocksSync(): void {
  for (const p of activeLockPaths) {
    try {
      unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
  activeLockPaths.clear();
}

function ensureSignalCleanupRegistered(): void {
  if (signalCleanupRegistered) return;
  signalCleanupRegistered = true;
  // We never unregister this — the cost of leaving an empty-set callback
  // around is negligible (a single function call on shutdown), and we'd
  // otherwise have to track refcounts of in-flight locks just to remove
  // the registration when the last lock releases. The bookkeeping bug
  // surface isn't worth the savings.
  addCleanup(releaseAllLocksSync);
}

/**
 * Read the PID recorded in a lock file. Returns `undefined` if the file
 * is missing, empty, or contains something that doesn't parse as a
 * positive integer. We tolerate the empty/junk case because lock files
 * written by pre-LEV-199 lich are zero-byte — we want to treat
 * those as stale-but-recoverable rather than crashing.
 */
async function readLockPid(lockPath: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  const pid = Number(raw.trim());
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  return pid;
}

/**
 * `process.kill(pid, 0)` is the POSIX trick for "is this pid alive?" —
 * it sends no signal but throws ESRCH if the process is gone. On
 * Windows, Node implements the same semantics: a 0 signal is a
 * permission/existence probe. Returns true if the process is alive (or
 * if we lack permission to probe it — EPERM means the process exists
 * but is owned by someone else, which from the lock's perspective is
 * still "alive, do not reclaim").
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process → stale.
    // EPERM = exists but not ours → treat as alive (don't steal).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * If the lock file references a dead PID, unlink it and return true so
 * the caller can retry the acquire. Returns false otherwise (lock is
 * legitimately held by an alive process, or we couldn't determine the
 * holder).
 *
 * Surfacing the reclaim as a single-line warning on stderr — agents
 * watching CI logs need to know we did this. Silent reclaim would hide
 * the original Ctrl-C that left the stale lock.
 */
async function reclaimIfStale(lockPath: string): Promise<boolean> {
  const pid = await readLockPid(lockPath);
  if (pid === undefined) return false;
  if (isPidAlive(pid)) return false;
  try {
    await unlink(lockPath);
  } catch {
    // Someone else may have unlinked it between our read and our unlink.
    // The next acquire attempt will find out.
    return false;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `lich: reclaimed stale lock ${lockPath} (held by dead pid ${pid})`,
  );
  return true;
}

/**
 * Acquire an advisory exclusive lock on `<path>.lock`. Uses O_CREAT|O_EXCL so
 * the create-or-fail is atomic on every POSIX filesystem we care about.
 * Returns a release function that deletes the lock file.
 *
 * LEV-199: on acquire, we write our PID into the lock file and register
 * the path with the shared signal-handler module so SIGINT/SIGTERM
 * unlinks the file before exiting. If we find an existing lock whose
 * holder is a dead PID (e.g. a previous run that was SIGKILLed before
 * its signal handler ran), we reclaim it and retry rather than waiting
 * out the full timeout.
 */
export async function acquireLock(
  path: string,
  opts: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 20;

  await mkdir(dirname(lockPath), { recursive: true });
  ensureSignalCleanupRegistered();

  const deadline = Date.now() + timeoutMs;
  // We allow at most one stale-lock reclaim per acquire. If we reclaim
  // and then fail again immediately, something stranger is going on
  // (rapid-fire races, a daemon constantly re-locking, etc.) — fall
  // through to the normal wait so we don't loop forever.
  let attemptedReclaim = false;
  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        // Best-effort PID record so future acquires can detect a stale
        // holder. If this fails we still hold the lock (the file exists)
        // — the stale-detection path just won't have a PID to probe and
        // will fall back to the normal wait/timeout. Don't let a write
        // failure surface to the caller.
        await writeFile(fh, String(process.pid), 'utf8');
      } catch {
        /* best-effort */
      }
      await fh.close();
      activeLockPaths.add(lockPath);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        activeLockPaths.delete(lockPath);
        try {
          await unlink(lockPath);
        } catch {
          /* idempotent release */
        }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!attemptedReclaim) {
        attemptedReclaim = true;
        const reclaimed = await reclaimIfStale(lockPath);
        if (reclaimed) continue; // immediate retry without waiting
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(path, timeoutMs);
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
}
