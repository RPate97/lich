import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksCurrentCommand } from '../../src/commands/stacks/current';
import { CLIError } from '../../src/errors';

let tmp: string;
let registryPath: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-cur-')));
  registryPath = join(tmp, 'registry.json');
});

describe('levelzero stacks current', () => {
  it('errors NO_PROJECT when cwd is not inside a levelzero project', async () => {
    const cmd = makeStacksCurrentCommand(() => new Registry(registryPath));
    await expect(
      cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('returns worktree info even with no registry entry', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const cmd = makeStacksCurrentCommand(() => new Registry(registryPath));
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.path).toBe(tmp);
    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.running).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('returns the registry entry when one exists', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const reg = new Registry(registryPath);
    const { computeWorktreeKey } = await import('../../src/worktree');
    const key = computeWorktreeKey(tmp);
    await reg.upsert(key, {
      path: tmp,
      branch: 'main',
      ports: { postgres: 54123 },
      urls: {},
      containers: [],
      network: '',
      logDir: '.levelzero/logs',
      createdAt: '2026-05-16T00:00:00Z',
    });
    const cmd = makeStacksCurrentCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.running).toBe(true);
    expect(result.entry.ports.postgres).toBe(54123);
  });
});
