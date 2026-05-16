import { open, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
 * Acquire an advisory exclusive lock on `<path>.lock`. Uses O_CREAT|O_EXCL so
 * the create-or-fail is atomic on every POSIX filesystem we care about.
 * Returns a release function that deletes the lock file.
 */
export async function acquireLock(
  path: string,
  opts: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 20;

  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await unlink(lockPath);
        } catch {
          /* idempotent release */
        }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new LockTimeoutError(path, timeoutMs);
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
}
