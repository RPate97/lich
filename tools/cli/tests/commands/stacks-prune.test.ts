import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksPruneCommand } from '../../src/commands/stacks/prune';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prune-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('levelzero stacks prune', () => {
  it('removes entries pointing at paths that no longer exist', async () => {
    const live = join(tmp, 'live');
    const dead = join(tmp, 'dead');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    await reg.upsert('dead', { path: dead, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual(['dead']);
    const after = await reg.list();
    expect(after.map(e => e.key)).toEqual(['live']);
  });

  it('returns an empty pruned array when all paths exist', async () => {
    const live = join(tmp, 'live');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual([]);
  });
});
