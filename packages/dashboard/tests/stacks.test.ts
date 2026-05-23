// packages/dashboard/tests/stacks.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStackViews } from '../src/server/stacks';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeWorktreeWithPids(
  key: string,
  pids: Record<string, number>,
): Promise<string> {
  const wt = await mkdtemp(join(tmpdir(), 'wt-'));
  const pidsDir = join(wt, '.levelzero', 'state', key, 'pids');
  await mkdir(pidsDir, { recursive: true });
  for (const [name, pid] of Object.entries(pids)) {
    await writeFile(join(pidsDir, `${name}.pid`), `${pid}\n`);
  }
  return wt;
}

describe('buildStackViews', () => {
  it('marks a stack down with worktreeMissing when its path is gone', async () => {
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: '/gone/worktree',
          branch: 'feat',
          ports: {},
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
        },
      },
    });
    expect(views).toHaveLength(1);
    expect(views[0]!.worktreeMissing).toBe(true);
    expect(views[0]!.status).toBe('down');
    expect(views[0]!.services).toEqual([]);
  });

  it('derives running when all owned services are alive (no URL → healthy)', async () => {
    const wt = await makeWorktreeWithPids('abc', { api: process.pid });
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: wt,
          branch: 'main',
          ports: { 'api-http': 5402 },
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
        },
      },
    });
    expect(views[0]!.status).toBe('running');
    const api = views[0]!.services.find((s) => s.name === 'api')!;
    expect(api.kind).toBe('owned');
    expect(api.status).toBe('healthy');
    await rm(wt, { recursive: true, force: true });
  });

  it('derives running when alive and HTTP probe returns 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const wt = await makeWorktreeWithPids('abc', { api: process.pid });
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: wt,
          branch: 'main',
          ports: { 'api-http': 5402 },
          urls: { api: 'http://localhost:5402' },
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
        },
      },
    });
    expect(views[0]!.status).toBe('running');
    const api = views[0]!.services.find((s) => s.name === 'api')!;
    expect(api.status).toBe('healthy');
    expect(api.url).toBe('http://localhost:5402');
    await rm(wt, { recursive: true, force: true });
  });

  it('derives partial when some services are down', async () => {
    const wt = await makeWorktreeWithPids('abc', {
      api: process.pid,
      web: 2147483646,
    });
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: wt,
          branch: 'main',
          ports: {},
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
        },
      },
    });
    expect(views[0]!.status).toBe('partial');
    await rm(wt, { recursive: true, force: true });
  });

  it('derives partial when one service is healthy and another is unhealthy', async () => {
    // api: alive + probe fails after grace; web: alive + no URL
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const pidsDir = join(wt, '.levelzero', 'state', 'abc', 'pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(join(pidsDir, 'api.pid'), `${process.pid}\n`);
    await writeFile(join(pidsDir, 'web.pid'), `${process.pid}\n`);

    const views = await buildStackViews({
      stacks: {
        abc: {
          path: wt,
          branch: 'main',
          ports: {},
          // api has a URL (will be probed → 503 → unhealthy after grace)
          // web has no URL → healthy
          urls: { api: 'http://localhost:9999' },
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z', // well past grace
        },
      },
    });
    expect(views[0]!.status).toBe('partial');
    const api = views[0]!.services.find((s) => s.name === 'api')!;
    const web = views[0]!.services.find((s) => s.name === 'web')!;
    expect(api.status).toBe('unhealthy');
    expect(web.status).toBe('healthy');
    await rm(wt, { recursive: true, force: true });
  });

  it('derives down when an empty stack has no services', async () => {
    const wt = await mkdtemp(join(tmpdir(), 'wt-'));
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: wt,
          branch: 'main',
          ports: {},
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
        },
      },
    });
    expect(views[0]!.status).toBe('down');
    await rm(wt, { recursive: true, force: true });
  });

  // LEV-241 — agent attribution round-trip tests.
  it('LEV-241: carries startedBy through to StackView when present', async () => {
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: '/gone/worktree',
          branch: 'feat',
          ports: {},
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
          startedBy: 'wraith',
        },
      },
    });
    expect(views).toHaveLength(1);
    expect(views[0]!.startedBy).toBe('wraith');
  });

  it('LEV-241: startedBy is undefined in StackView when absent from registry entry', async () => {
    const views = await buildStackViews({
      stacks: {
        abc: {
          path: '/gone/worktree',
          branch: 'feat',
          ports: {},
          urls: {},
          containers: [],
          network: 'n',
          logDir: '.levelzero/logs',
          createdAt: '2026-05-21T00:00:00.000Z',
          // startedBy deliberately omitted — legacy / manual entry.
        },
      },
    });
    expect(views).toHaveLength(1);
    expect(views[0]!.startedBy).toBeUndefined();
  });
});
