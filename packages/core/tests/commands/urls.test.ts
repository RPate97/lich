import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { computeWorktreeKey } from '../../src/worktree';
import { makeUrlsCommand, urlsCommand } from '../../src/commands/urls';
import { CLIError } from '../../src/errors';

let tmp: string;
let registryPath: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-urls-')));
  registryPath = join(tmp, 'registry.json');
  reg = new Registry(registryPath);
});

describe('lich urls', () => {
  it('exports a Command named "urls"', () => {
    expect(urlsCommand.name).toBe('urls');
  });

  it('errors NO_PROJECT when cwd is not inside a lich project', async () => {
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    await expect(
      cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('returns urls from StackEntry.urls for the current worktree', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const key = computeWorktreeKey(tmp);
    await reg.upsert(key, {
      path: tmp,
      branch: 'main',
      ports: { web: 3000, api: 4000 },
      urls: { web: 'http://main.myapp.localhost', api: 'http://api.main.myapp.localhost' },
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: '2026-05-17T00:00:00Z',
    });
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as {
      urls: Array<{ service: string; host: string; target: string }>;
    };
    expect(result.urls).toHaveLength(2);
    const web = result.urls.find((u) => u.service === 'web')!;
    expect(web.host).toBe('main.myapp.localhost');
    expect(web.target).toBe('http://main.myapp.localhost');
    const api = result.urls.find((u) => u.service === 'api')!;
    expect(api.host).toBe('api.main.myapp.localhost');
    expect(api.target).toBe('http://api.main.myapp.localhost');
  });

  it('falls back to plain http://localhost:<port> when urls map is empty', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const key = computeWorktreeKey(tmp);
    await reg.upsert(key, {
      path: tmp,
      branch: 'main',
      ports: { web: 3000, api: 4000 },
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: '2026-05-17T00:00:00Z',
    });
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as {
      urls: Array<{ service: string; host: string; target: string }>;
    };
    expect(result.urls).toHaveLength(2);
    const web = result.urls.find((u) => u.service === 'web')!;
    expect(web.host).toBe('localhost:3000');
    expect(web.target).toBe('http://localhost:3000');
    const api = result.urls.find((u) => u.service === 'api')!;
    expect(api.host).toBe('localhost:4000');
    expect(api.target).toBe('http://localhost:4000');
  });

  it('returns an empty urls array when the current worktree has no registry entry', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as {
      urls: unknown[];
    };
    expect(result.urls).toEqual([]);
  });

  it('with --all, returns urls grouped by stack key for every registered stack', async () => {
    await reg.upsert('k1', {
      path: '/a',
      branch: 'a',
      ports: { web: 3001 },
      urls: { web: 'http://feature-a.myapp.localhost' },
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
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as {
      stacks: Array<{
        key: string;
        urls: Array<{ service: string; host: string; target: string }>;
      }>;
    };
    expect(result.stacks).toHaveLength(2);
    const k1 = result.stacks.find((s) => s.key === 'k1')!;
    expect(k1.urls).toEqual([
      { service: 'web', host: 'feature-a.myapp.localhost', target: 'http://feature-a.myapp.localhost' },
    ]);
    const k2 = result.stacks.find((s) => s.key === 'k2')!;
    expect(k2.urls).toEqual([
      { service: 'web', host: 'localhost:3002', target: 'http://localhost:3002' },
    ]);
  });

  it('--all does not require being inside a lich project', async () => {
    await reg.upsert('only', {
      path: '/x',
      branch: '',
      ports: { web: 5000 },
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: '',
    });
    const cmd = makeUrlsCommand({ getRegistry: () => reg });
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as {
      stacks: Array<{ key: string; urls: unknown[] }>;
    };
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]!.key).toBe('only');
  });
});
