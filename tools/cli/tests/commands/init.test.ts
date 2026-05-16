import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../src/commands/init';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-init-')));
});

describe('levelzero init', () => {
  it('creates levelzero.config.ts in cwd if not present', async () => {
    const result = await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const path = join(tmp, 'levelzero.config.ts');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/export default/);
    expect(result).toMatchObject({ created: true, configPath: path });
  });

  it('refuses to overwrite an existing config without --force', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    await expect(
      initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/already exists/);
  });

  it('--force overwrites an existing config', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const result = await initCommand.run({
      cwd: tmp, format: 'json', args: [], flags: { force: true },
    });
    expect(result).toMatchObject({ created: true });
  });
});
