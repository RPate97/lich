// packages/dashboard/tests/registry-reader.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry } from '../src/server/registry-reader';

describe('readRegistry', () => {
  it('returns an empty stack list when the file is absent', async () => {
    const data = await readRegistry(join(tmpdir(), 'does-not-exist-xyz.json'));
    expect(data).toEqual({ stacks: {} });
  });

  it('parses stacks and defaults a missing urls field to {}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-'));
    const path = join(dir, 'registry.json');
    await writeFile(
      path,
      JSON.stringify({
        stacks: {
          abc: {
            path: '/wt/a',
            branch: 'main',
            ports: { 'api-http': 5402 },
            containers: ['proj-postgres-1'],
            network: 'proj_net',
            logDir: '.levelzero/logs',
            createdAt: '2026-05-21T00:00:00.000Z',
          },
        },
      }),
    );
    const data = await readRegistry(path);
    expect(data.stacks['abc']!.urls).toEqual({});
    expect(data.stacks['abc']!.branch).toBe('main');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty stack list when the file is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-'));
    const path = join(dir, 'registry.json');
    await writeFile(path, '{ not json');
    const data = await readRegistry(path);
    expect(data).toEqual({ stacks: {} });
    await rm(dir, { recursive: true, force: true });
  });
});
