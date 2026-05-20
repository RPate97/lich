import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  activeLockPaths,
  LockTimeoutError,
  __resetRegistryLockForTest,
} from '../src/registry-lock';
import { __resetForTest, __fireForTest, __setExitFnForTest } from '../src/signal-handlers';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-lock-')));
  __resetForTest();
  __resetRegistryLockForTest();
  // Each test that drives the signal path swaps in its own exitFn; default
  // here is a throwing stub so we never tear down the test runner.
  __setExitFnForTest(((_code: number) => {
    throw new Error('process.exit invoked unexpectedly in registry-lock test');
  }) as (code: number) => never);
});

describe('acquireLock', () => {
  it('returns a release function that removes the lock', async () => {
    const path = join(tmp, 'r.json');
    const release = await acquireLock(path);
    expect(typeof release).toBe('function');
    await release();
  });

  it('serializes two concurrent callers (second waits for first to release)', async () => {
    const path = join(tmp, 'r.json');
    const order: string[] = [];

    const a = (async () => {
      const r = await acquireLock(path);
      order.push('A-acquired');
      await new Promise((res) => setTimeout(res, 50));
      order.push('A-releasing');
      await r();
    })();

    await new Promise((res) => setTimeout(res, 10));

    const b = (async () => {
      const r = await acquireLock(path);
      order.push('B-acquired');
      await r();
    })();

    await Promise.all([a, b]);
    expect(order).toEqual(['A-acquired', 'A-releasing', 'B-acquired']);
  });

  it('times out if the lock is never released', async () => {
    const path = join(tmp, 'r.json');
    const release = await acquireLock(path);
    await expect(acquireLock(path, { timeoutMs: 100 })).rejects.toThrow(LockTimeoutError);
    await release();
  });

  it('writes the holder PID into the lock file (LEV-199)', async () => {
    const path = join(tmp, 'r.json');
    const release = await acquireLock(path);
    const raw = readFileSync(`${path}.lock`, 'utf8').trim();
    expect(Number(raw)).toBe(process.pid);
    await release();
  });

  it('reclaims a stale lock whose recorded PID is dead (LEV-199)', async () => {
    const path = join(tmp, 'r.json');
    const lockPath = `${path}.lock`;
    // Pre-existing lock file holding an obviously-dead PID. Linux/macOS
    // pid_max is typically 2^22; 99999999 will never be live on the test
    // host. We also silence the reclaim warning so the test output is
    // clean.
    writeFileSync(lockPath, '99999999');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const release = await acquireLock(path, { timeoutMs: 1_000 });
    // After reclaim, the lock should hold our PID instead.
    const raw = readFileSync(lockPath, 'utf8').trim();
    expect(Number(raw)).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/reclaimed stale lock.*pid 99999999/),
    );
    await release();
    warnSpy.mockRestore();
  });

  it('does NOT reclaim a lock whose recorded PID is alive', async () => {
    const path = join(tmp, 'r.json');
    const lockPath = `${path}.lock`;
    // Use OUR own PID — definitionally alive — to assert non-reclaim.
    writeFileSync(lockPath, String(process.pid));
    await expect(
      acquireLock(path, { timeoutMs: 150 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('does NOT reclaim a legacy zero-byte lock file without retrying forever', async () => {
    // Pre-LEV-199 lock files are zero-byte. We don't have a PID to probe,
    // so the safe call is to leave them alone and wait — operators can
    // remove them via `doctor`/manually.
    const path = join(tmp, 'r.json');
    writeFileSync(`${path}.lock`, '');
    await expect(
      acquireLock(path, { timeoutMs: 150 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('registers the lock path for signal-handler cleanup, deregisters on release', async () => {
    const path = join(tmp, 'r.json');
    expect(activeLockPaths.has(`${path}.lock`)).toBe(false);
    const release = await acquireLock(path);
    expect(activeLockPaths.has(`${path}.lock`)).toBe(true);
    await release();
    expect(activeLockPaths.has(`${path}.lock`)).toBe(false);
  });

  it('SIGINT unlinks held lock files synchronously (LEV-199 regression)', async () => {
    // This is the bug: SIGINT during `dev` leaves a stale lock that
    // blocks every future invocation for 30s. The fix: register a
    // cleanup with the shared signal-handler module on every acquire.
    const path = join(tmp, 'r.json');
    const lockPath = `${path}.lock`;
    // Don't actually exit the test runner — swap in a recording stub.
    let exitedCode: number | undefined;
    __setExitFnForTest(((code: number) => {
      exitedCode = code;
      return undefined as never;
    }) as (code: number) => never);

    await acquireLock(path);
    expect(existsSync(lockPath)).toBe(true);

    __fireForTest('SIGINT');

    // Synchronous cleanup path: the unlink must have happened before
    // the exit call returned.
    expect(existsSync(lockPath)).toBe(false);
    expect(exitedCode).toBe(130);
  });
});
