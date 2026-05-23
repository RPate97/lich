import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry';
import { computeWorktreeKey } from '../src/worktree';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p04-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p04-home-')));
  // Declare the extracted plugin via lich.config.ts so each plan-04 e2e
  // also exercises the plugin loader path with a real package (LEV-146): the
  // loader must resolve `@lich/plugin-portless` from the workspace, run
  // its `register()`, and merge its adapters into the dispatch registry — all
  // without disrupting any inline command (`urls` here is inline).
  writeFileSync(
    join(projectDir, 'lich.config.ts'),
    `export default { plugins: ['@lich/plugin-portless'] };`,
  );
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

/**
 * Plan-04 (portless URLs) end-to-end: simulate what `dev` would do with a
 * portless mock adapter — namely, persist `StackEntry.urls` — by seeding the
 * tmp registry directly, then assert `bun bin.ts urls` reads those URLs back
 * via the bin entry point.
 *
 * We deliberately skip invoking `dev` here: the bin doesn't expose a DI hook
 * for the portless adapter (only `makeDevCommand` does), and the goal of this
 * e2e is to prove the `urls` command is wired into `bin.ts` and surfaces the
 * URLs that a portless-registering `dev` would have persisted.
 */
describe('bin: plan-04 urls end-to-end', () => {
  it('urls returns persisted StackEntry.urls for the current worktree as JSON', async () => {
    const reg = new Registry(join(homeDir, '.lich', 'registry.json'));
    await reg.upsert(computeWorktreeKey(projectDir), {
      path: projectDir,
      branch: 'main',
      ports: { web: 3000, api: 4000 },
      urls: {
        web: 'https://main.web.myapp.localhost',
        api: 'https://main.api.myapp.localhost',
      },
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: '2026-05-17T00:00:00Z',
    });

    const res = run(['urls', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      urls: Array<{ service: string; host: string; target: string }>;
    };
    expect(out.urls).toHaveLength(2);
    const web = out.urls.find((u) => u.service === 'web')!;
    expect(web.host).toBe('main.web.myapp.localhost');
    expect(web.target).toBe('https://main.web.myapp.localhost');
    const api = out.urls.find((u) => u.service === 'api')!;
    expect(api.host).toBe('main.api.myapp.localhost');
    expect(api.target).toBe('https://main.api.myapp.localhost');
  });

  it('urls falls back to http://localhost:<port> rows when StackEntry.urls is empty', async () => {
    const reg = new Registry(join(homeDir, '.lich', 'registry.json'));
    await reg.upsert(computeWorktreeKey(projectDir), {
      path: projectDir,
      branch: 'main',
      ports: { web: 3001 },
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: '2026-05-17T00:00:00Z',
    });

    const res = run(['urls', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      urls: Array<{ service: string; host: string; target: string }>;
    };
    expect(out.urls).toEqual([
      { service: 'web', host: 'localhost:3001', target: 'http://localhost:3001' },
    ]);
  });

  it('urls --all returns every stack regardless of cwd', async () => {
    const reg = new Registry(join(homeDir, '.lich', 'registry.json'));
    await reg.upsert('k1', {
      path: '/a',
      branch: 'a',
      ports: { web: 3001 },
      urls: { web: 'https://a.web.myapp.localhost' },
      containers: [],
      network: '',
      logDir: '',
      createdAt: '',
    });
    await reg.upsert('k2', {
      path: '/b',
      branch: 'b',
      ports: { web: 3002 },
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: '',
    });

    const res = run(['urls', '--all', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      stacks: Array<{
        key: string;
        urls: Array<{ service: string; host: string; target: string }>;
      }>;
    };
    expect(out.stacks).toHaveLength(2);
    const k1 = out.stacks.find((s) => s.key === 'k1')!;
    expect(k1.urls).toEqual([
      {
        service: 'web',
        host: 'a.web.myapp.localhost',
        target: 'https://a.web.myapp.localhost',
      },
    ]);
    const k2 = out.stacks.find((s) => s.key === 'k2')!;
    expect(k2.urls).toEqual([
      { service: 'web', host: 'localhost:3002', target: 'http://localhost:3002' },
    ]);
  });

  it('urls without --all errors NO_PROJECT when cwd is not a lich project', () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p04-out-')));
    const res = spawnSync('bun', [BIN, 'urls', '--json'], {
      cwd: outsideDir,
      env: { ...process.env, LICH_HOME: homeDir },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).toBe('NO_PROJECT');
  });

  it('urls is registered in bin (not an UNKNOWN_COMMAND)', () => {
    // Sanity: even when the worktree has no entry, bin should reach the command
    // and return an empty urls array — never UNKNOWN_COMMAND.
    const res = run(['urls', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as { urls: unknown[] };
    expect(out.urls).toEqual([]);
  });
});
