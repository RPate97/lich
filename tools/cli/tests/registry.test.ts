import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/registry';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reg-')));
});

describe('Registry', () => {
  it('returns an empty registry when the file does not exist', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    const data = await reg.read();
    expect(data).toEqual({ stacks: {} });
  });

  it('persists upsert via atomic rename', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('abc123', {
      path: '/some/path',
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: '2026-05-16T00:00:00Z',
    });
    expect(existsSync(join(tmp, 'registry.json'))).toBe(true);
    const data = await reg.read();
    expect(data.stacks['abc123']!.path).toBe('/some/path');
  });

  it('remove() deletes a stack entry', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('k1', {
      path: '/p', branch: 'b', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.remove('k1');
    const data = await reg.read();
    expect(data.stacks['k1']).toBeUndefined();
  });

  it('list() returns all entries', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('k1', {
      path: '/a', branch: 'a', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.upsert('k2', {
      path: '/b', branch: 'b', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    const entries = await reg.list();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.key).sort()).toEqual(['k1', 'k2']);
  });
});
