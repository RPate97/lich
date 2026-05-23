import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiAddCommand } from '../../src/commands/add';
import { CLIError } from '@lich/core';

let projectDir: string;
beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-uiadd-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
});

describe('lich ui add', () => {
  it('errors NO_PROJECT outside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-uiadd-outside-')));
    await expect(
      uiAddCommand.run({ cwd: outside, format: 'json', args: ['button'], flags: { 'dry-run': true } }),
    ).rejects.toThrow(/not inside a lich project/i);
  });

  it('errors when no component arg is given', async () => {
    await expect(
      uiAddCommand.run({ cwd: projectDir, format: 'json', args: [], flags: { 'dry-run': true } }),
    ).rejects.toThrow(CLIError);
  });

  it('dry-run returns the command without executing', async () => {
    const result = (await uiAddCommand.run({
      cwd: projectDir, format: 'json', args: ['button'], flags: { 'dry-run': true },
    })) as any;
    expect(result.executed).toBe(false);
    expect(result.command).toContain('shadcn');
    expect(result.command).toContain('button');
  });

  it('--app-dir flag overrides the default apps/web', async () => {
    const result = (await uiAddCommand.run({
      cwd: projectDir, format: 'json', args: ['button'], flags: { 'dry-run': true, 'app-dir': 'apps/admin' },
    })) as any;
    expect(result.cwd).toContain('apps/admin');
  });
});
