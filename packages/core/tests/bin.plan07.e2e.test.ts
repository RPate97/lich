import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p07-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p07-home-')));
  // Post-LEV-165 the `test` command is no longer seeded by the inline
  // `buildCommands` — it only lights up when a plugin contributes a
  // `test-runner` adapter (the dispatch path registers the command against
  // the merged plugin-aware registry). The smoke checks below exercise the
  // command's arg-validation, which runs BEFORE adapter resolution, so any
  // plugin that contributes a `test-runner` impl satisfies the registration.
  // We declare `@levelzero/plugin-vitest` to make `test` a real registered
  // command — without it the failures below would surface as
  // UNKNOWN_COMMAND, which is exactly what the assertions guard against.
  writeFileSync(
    join(projectDir, 'levelzero.config.ts'),
    `export default { plugins: ['@levelzero/plugin-vitest'] };`,
  );
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LEVELZERO_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-07 test command end-to-end', () => {
  // The unit/integration/e2e dispatch paths themselves spawn vitest/playwright
  // against fixtures + a running stack — way too much setup for a bin smoke
  // test. The contract this test pins down is the cheaper, more important one:
  // `test` is reachable through bin.ts, and the command's own arg validation
  // (CONFIG_INVALID, not UNKNOWN_COMMAND) fires before any adapter work.

  it('rejects `test` with no subcommand as CONFIG_INVALID (proves the command is registered, not unknown)', () => {
    const res = run(['test', '--json']);
    expect(res.status).toBe(1);
    // stderr is JSON-formatted CLIError output.
    const err = JSON.parse(res.stderr) as { code: string; message: string; hint?: string };
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.message).toMatch(/subcommand/i);
    expect(err.hint).toMatch(/unit\|integration\|e2e/);
  });

  it('rejects `test unknown-mode` as CONFIG_INVALID with the offending subcommand in the message', () => {
    const res = run(['test', 'unknown-mode', '--json']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr) as { code: string; message: string; hint?: string };
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.message).toMatch(/unknown.*unknown-mode/i);
    expect(err.hint).toMatch(/unit\|integration\|e2e/);
  });
});
