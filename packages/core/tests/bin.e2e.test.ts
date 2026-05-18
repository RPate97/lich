import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-e2e-')));
});

const BIN = join(__dirname, '..', 'src', 'bin.ts');

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync('bun', [BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('bin end-to-end', () => {
  it('init then stacks current returns running:false (--json for parse)', () => {
    const initRes = run(['init'], tmp, { LEVELZERO_HOME: tmp });
    expect(initRes.status).toBe(0);

    const curRes = run(['stacks', 'current', '--json'], tmp, { LEVELZERO_HOME: tmp });
    expect(curRes.status).toBe(0);
    const parsed = JSON.parse(curRes.stdout);
    expect(parsed.path).toBe(tmp);
    expect(parsed.running).toBe(false);
  });

  it('unknown command returns exit 1 with JSON error when --json passed', () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const res = run(['no-such-command', '--json'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });
});
