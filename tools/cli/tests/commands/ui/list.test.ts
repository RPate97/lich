import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiListCommand } from '../../../src/commands/ui/list';

let projectDir: string;
beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-uilist-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

describe('levelzero ui list', () => {
  it('returns empty installed array when apps/web does not exist', async () => {
    const result = (await uiListCommand.run({
      cwd: projectDir, format: 'json', args: [], flags: {},
    })) as any;
    expect(result.installed).toEqual([]);
  });
});
