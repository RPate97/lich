import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCheckCommand } from '../../src/commands/check';
import { RuleRegistry } from '../../src/check/registry';
import type { Rule } from '../../src/check/types';

let projectDir: string;
beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-chk-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

describe('levelzero check', () => {
  it('returns ok=true with default stub rules (all skip)', async () => {
    const cmd = makeCheckCommand();
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.summary.skip).toBe(3);
    expect(result.summary.fail).toBe(0);
  });

  it('returns ok=false when any injected rule fails', async () => {
    const failingRule: Rule = {
      id: 'fails',
      describe: 'always fails',
      check: async () => ({ status: 'fail', message: 'because' }),
    };
    const registry = new RuleRegistry();
    registry.register(failingRule);
    const cmd = makeCheckCommand({ getRules: () => registry });
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(false);
    expect(result.summary.fail).toBe(1);
  });
});
