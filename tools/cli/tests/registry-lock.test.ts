import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockTimeoutError } from '../src/registry-lock';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-lock-')));
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
});
