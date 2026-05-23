import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksListCommand } from '../../src/commands/stacks/list';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-list-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('lich stacks list', () => {
  it('returns an empty array when no stacks are registered', async () => {
    const cmd = makeStacksListCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.stacks).toEqual([]);
  });

  it('returns every registry entry, keyed', async () => {
    await reg.upsert('k1', {
      path: '/a', branch: 'a', ports: { postgres: 1 }, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.upsert('k2', {
      path: '/b', branch: 'b', ports: { postgres: 2 }, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    const cmd = makeStacksListCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.stacks).toHaveLength(2);
    const keys = result.stacks.map((s: any) => s.key).sort();
    expect(keys).toEqual(['k1', 'k2']);
  });
});
