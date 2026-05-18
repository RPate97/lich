import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-help-e2e-')));
});

const BIN = join(__dirname, '..', 'src', 'bin.ts');

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync('bun', [BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('bin: --help / -h / help / no-args', () => {
  // The four invocations the spec promises render the same help text. We
  // also verify they exit 0 and write to stdout (not stderr) — the previous
  // behavior was an UNKNOWN_COMMAND error on stderr with exit 1.

  it('`levelzero --help` prints help to stdout, exit 0', () => {
    const res = run(['--help'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('levelzero — extensible dev environment orchestrator');
    expect(res.stdout).toContain('USAGE');
    expect(res.stdout).toContain('LOADED PLUGINS');
  });

  it('`levelzero -h` prints help to stdout, exit 0', () => {
    const res = run(['-h'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('USAGE');
  });

  it('`levelzero help` prints help to stdout, exit 0', () => {
    const res = run(['help'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('USAGE');
  });

  it('`levelzero` (no args) prints help (replaces the old UNKNOWN_COMMAND error)', () => {
    const res = run([], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('USAGE');
    expect(res.stdout).not.toContain('UNKNOWN_COMMAND');
  });

  it('lists every inline-registered built-in command', () => {
    const res = run(['--help'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    // Sample a few from each curated group — `buildCommands` is the source
    // of truth, and these are stable post-LEV-148–156 (the Tier 5 cutover).
    // If a command is later moved out into a plugin, the assertion for it
    // here doubles as a check that the inline registration was actually
    // removed.
    const out = res.stdout;
    expect(out).toContain('dev');
    expect(out).toContain('stop');
    expect(out).toContain('reset');
    expect(out).toContain('init');
    expect(out).toContain('doctor');
    expect(out).toContain('urls');
    expect(out).toContain('logs');
    expect(out).toContain('impact');
    expect(out).toContain('coverage');
    expect(out).toContain('check');
    expect(out).toContain('screenshot');
    expect(out).toContain('compose');
    expect(out).toContain('test');
    // Dotted commands rendered with spaces (matches how they're typed).
    expect(out).toContain('stacks current');
    expect(out).toContain('stacks list');
    expect(out).toContain('stacks prune');
    expect(out).toContain('adapter list');
    expect(out).toContain('adapter swap');
    expect(out).toContain('gen client');
    expect(out).toContain('visual diff');
    expect(out).toContain('skills index');
  });

  it('with no project config in cwd, LOADED PLUGINS shows the empty-state message', () => {
    const res = run(['--help'], tmp, { LEVELZERO_HOME: tmp });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      '(no project plugins loaded — declare them in levelzero.config.ts)',
    );
  });
});
