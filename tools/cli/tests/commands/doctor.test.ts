import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeDoctorCommand } from '../../src/commands/doctor';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-doc-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('levelzero doctor', () => {
  it('reports no_project when not inside a project, with all infra checks ok', async () => {
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('skipped');
    expect(result.checks.find((c: any) => c.id === 'registry').status).toBe('ok');
  });

  it('reports project ok when inside a valid project', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('ok');
    expect(result.checks.find((c: any) => c.id === 'config').status).toBe('ok');
  });

  it('reports config error when the config file is malformed', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export const foo = 1;');
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(false);
    const cfg = result.checks.find((c: any) => c.id === 'config');
    expect(cfg.status).toBe('error');
    expect(cfg.message).toMatch(/default export/i);
  });
});
