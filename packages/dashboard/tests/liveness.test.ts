// packages/dashboard/tests/liveness.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOwnedServices, isPidAlive } from '../src/server/liveness';

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unallocated pid as dead', () => {
    // pid 2^31-1 is effectively never allocated
    expect(isPidAlive(2147483646)).toBe(false);
  });

  it('treats NaN / 0 as dead', () => {
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });
});

describe('readOwnedServices', () => {
  it('returns [] when the pids dir is absent', async () => {
    const out = await readOwnedServices('/no/such/worktree', 'abc');
    expect(out).toEqual([]);
  });

  it('reads pid files and reports liveness', async () => {
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.levelzero', 'state', 'abc', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);
    await writeFile(join(pidsDir, 'web.pid'), '2147483646\n');

    const out = await readOwnedServices(wt, 'abc');
    const byName = Object.fromEntries(out.map((s) => [s.name, s.status]));
    expect(byName['api']).toBe('up');
    expect(byName['web']).toBe('down');
    await rm(wt, { recursive: true, force: true });
  });

  it('treats an empty pid file as a down service', async () => {
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.levelzero', 'state', 'abc', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), '');
    const out = await readOwnedServices(wt, 'abc');
    expect(out).toEqual([{ name: 'api', status: 'down' }]);
    await rm(wt, { recursive: true, force: true });
  });
});
