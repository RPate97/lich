// packages/dashboard/tests/liveness.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOwnedServices,
  isPidAlive,
  probeUrl,
  deriveOwnedStatus,
  deriveContainerStatus,
  STARTUP_GRACE_MS,
} from '../src/server/liveness';

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

describe('probeUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok for a 2xx response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 });
    expect(await probeUrl('http://localhost:3000')).toBe('ok');
  });

  it('returns ok for a 3xx response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 301 });
    expect(await probeUrl('http://localhost:3000')).toBe('ok');
  });

  it('returns fail for a 4xx response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 404 });
    expect(await probeUrl('http://localhost:3000')).toBe('fail');
  });

  it('returns fail for a 5xx response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 503 });
    expect(await probeUrl('http://localhost:3000')).toBe('fail');
  });

  it('returns unreachable when fetch throws (connection refused)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await probeUrl('http://localhost:3000')).toBe('unreachable');
  });

  it('returns unreachable on timeout', async () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    expect(await probeUrl('http://localhost:3000', 100)).toBe('unreachable');
  });
});

describe('deriveOwnedStatus', () => {
  const pastCreatedAt = new Date(Date.now() - STARTUP_GRACE_MS - 1000).toISOString();
  const recentCreatedAt = new Date(Date.now() - 1000).toISOString();
  const now = Date.now();

  it('returns down when process is not alive', () => {
    expect(deriveOwnedStatus(false, null, pastCreatedAt, now)).toBe('down');
    expect(deriveOwnedStatus(false, 'ok', pastCreatedAt, now)).toBe('down');
  });

  it('returns healthy when alive and no URL to probe', () => {
    expect(deriveOwnedStatus(true, null, pastCreatedAt, now)).toBe('healthy');
  });

  it('returns healthy when probe returns ok', () => {
    expect(deriveOwnedStatus(true, 'ok', pastCreatedAt, now)).toBe('healthy');
  });

  it('returns starting when probe fails within grace window', () => {
    expect(deriveOwnedStatus(true, 'fail', recentCreatedAt, now)).toBe('starting');
    expect(deriveOwnedStatus(true, 'unreachable', recentCreatedAt, now)).toBe('starting');
  });

  it('returns unhealthy when probe fails after grace window', () => {
    expect(deriveOwnedStatus(true, 'fail', pastCreatedAt, now)).toBe('unhealthy');
    expect(deriveOwnedStatus(true, 'unreachable', pastCreatedAt, now)).toBe('unhealthy');
  });
});

describe('deriveContainerStatus', () => {
  it('returns down when container is not running', () => {
    expect(deriveContainerStatus(false, null)).toBe('down');
    expect(deriveContainerStatus(false, 'healthy')).toBe('down');
  });

  it('returns healthy when running with no docker healthcheck', () => {
    expect(deriveContainerStatus(true, null)).toBe('healthy');
  });

  it('returns healthy when docker health is healthy', () => {
    expect(deriveContainerStatus(true, 'healthy')).toBe('healthy');
  });

  it('returns starting when docker health is starting', () => {
    expect(deriveContainerStatus(true, 'starting')).toBe('starting');
  });

  it('returns unhealthy when docker health is unhealthy', () => {
    expect(deriveContainerStatus(true, 'unhealthy')).toBe('unhealthy');
  });

  it('returns unhealthy for docker health state exited or unknown', () => {
    expect(deriveContainerStatus(true, 'exited')).toBe('unhealthy');
    expect(deriveContainerStatus(true, 'unknown')).toBe('unhealthy');
  });
});

describe('readOwnedServices', () => {
  it('returns [] when the pids dir is absent', async () => {
    const out = await readOwnedServices('/no/such/worktree', 'abc');
    expect(out).toEqual([]);
  });

  it('reads pid files and reports alive process as healthy (no URL)', async () => {
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.lich', 'state', 'abc', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);
    await writeFile(join(pidsDir, 'web.pid'), '2147483646\n');

    const out = await readOwnedServices(wt, 'abc', {
      urls: {},
      createdAt: new Date(0).toISOString(),
    });
    const byName = Object.fromEntries(out.map((s) => [s.name, s.status]));
    expect(byName['api']).toBe('healthy');
    expect(byName['web']).toBe('down');
    await rm(wt, { recursive: true, force: true });
  });

  it('treats an empty pid file as a down service', async () => {
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.lich', 'state', 'abc', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), '');
    const out = await readOwnedServices(wt, 'abc', {
      urls: {},
      createdAt: new Date(0).toISOString(),
    });
    expect(out).toEqual([{ name: 'api', status: 'down' }]);
    await rm(wt, { recursive: true, force: true });
  });

  it('returns healthy when alive and probe returns ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.lich', 'state', 'k1', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);

    const out = await readOwnedServices(wt, 'k1', {
      urls: { api: 'http://localhost:9999' },
      createdAt: new Date(Date.now() - 60_000).toISOString(), // well past grace
      now: Date.now(),
    });
    expect(out.find((s) => s.name === 'api')?.status).toBe('healthy');

    vi.unstubAllGlobals();
    await rm(wt, { recursive: true, force: true });
  });

  it('returns unhealthy when alive, probe fails, and past grace window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.lich', 'state', 'k2', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);

    const now = Date.now();
    const out = await readOwnedServices(wt, 'k2', {
      urls: { api: 'http://localhost:9999' },
      createdAt: new Date(now - STARTUP_GRACE_MS - 5000).toISOString(),
      now,
    });
    expect(out.find((s) => s.name === 'api')?.status).toBe('unhealthy');

    vi.unstubAllGlobals();
    await rm(wt, { recursive: true, force: true });
  });

  it('returns starting when alive, probe fails, and within grace window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.lich', 'state', 'k3', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);

    const now = Date.now();
    const out = await readOwnedServices(wt, 'k3', {
      urls: { api: 'http://localhost:9999' },
      createdAt: new Date(now - 1000).toISOString(), // 1s ago, well within grace
      now,
    });
    expect(out.find((s) => s.name === 'api')?.status).toBe('starting');

    vi.unstubAllGlobals();
    await rm(wt, { recursive: true, force: true });
  });
});
