import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-cfg-')));
});

describe('loadConfig', () => {
  it('loads an empty config', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default {};');
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({});
  });

  it('loads a config with a name field', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default { name: "myapp" };');
    const cfg = await loadConfig(path);
    expect(cfg.name).toBe('myapp');
  });

  it('throws a useful error when config has no default export', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export const foo = 1;');
    await expect(loadConfig(path)).rejects.toThrow(/default export/i);
  });
});
