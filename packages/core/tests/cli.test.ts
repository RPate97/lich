import { describe, it, expect } from 'vitest';
import { runCli } from '../src/cli';
import type { Command } from '../src/commands/types';
import { CommandRegistry } from '../src/commands/registry';
import { CLIError } from '../src/errors';
import { buildCommands } from '../src/bin';

function makeRegistry(commands: Command[]): CommandRegistry {
  const reg = new CommandRegistry();
  for (const c of commands) reg.register(c);
  return reg;
}

describe('runCli', () => {
  // LEV-168 — default output is pretty text; `--json` opts back into JSON.
  it('dispatches to a top-level command and prints pretty output by default', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo'], makeRegistry([echo]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    // Pretty mode falls back to indented JSON for object results when the
    // command doesn't supply its own renderer.
    expect(out.stdout).toContain('"said": "hi"');
  });

  it('honors --json (LEV-168 opt-in for structured output)', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo', '--json'], makeRegistry([echo]), { cwd: '/' });
    expect(out.stdout).toBe('{"said":"hi"}');
  });

  it('honors --pretty as an explicit alias (default since LEV-168)', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo', '--pretty'], makeRegistry([echo]), { cwd: '/' });
    expect(out.stdout).toContain('"said": "hi"');
    expect(out.stdout.includes('\n')).toBe(true);
  });

  it('supports nested command names with dots: stacks.current', async () => {
    const cur: Command = {
      name: 'stacks.current',
      describe: 'current',
      run: async () => ({ stack: 'x' }),
    };
    const out = await runCli(['stacks', 'current', '--json'], makeRegistry([cur]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).stack).toBe('x');
  });

  it('returns a structured error when the command is unknown (--json)', async () => {
    const out = await runCli(['nope', '--json'], makeRegistry([]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });

  it('returns a pretty error line by default for unknown commands (LEV-168)', async () => {
    const out = await runCli(['nope'], makeRegistry([]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('error:');
    expect(out.stderr).toContain('unknown command: nope');
    expect(out.stderr).toContain('hint:');
  });

  it('renders a CLIError raised by a command (--json)', async () => {
    const bad: Command = {
      name: 'bad',
      describe: 'bad',
      run: async () => {
        throw new CLIError('NO_PROJECT', 'not inside a levelzero project');
      },
    };
    const out = await runCli(['bad', '--json'], makeRegistry([bad]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stderr).code).toBe('NO_PROJECT');
  });

  // Post-LEV-152: `curl` is no longer registered inline in `buildCommands` —
  // it ships from `@levelzero/plugin-better-auth`. The bin-level smoke check
  // now verifies that `buildCommands` (the inline-only path) reports the
  // command as unknown; project-level dispatch via `buildDispatchRegistry`
  // wires it in when the plugin is loaded, which is covered by the plugin's
  // own tests.
  it('does not register curl in buildCommands (plugin-only after LEV-152)', async () => {
    const reg = buildCommands('/tmp/levelzero-bin-smoke-registry.json');
    const out = await runCli(['curl', '--json'], reg, { cwd: '/' });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });

  // Post-LEV-165 (Plan 14 Tier 7 cutover): `screenshot`, `visual.diff`,
  // `gen` (LEV-124 — replaced the one-off `gen client`), and `test` all
  // dropped their inline seeds in `buildCommands`. They only register
  // through `buildDispatchRegistry` after `bootPlugins()` wires up the
  // merged adapter / generator registries — without a project + plugins
  // they're UNKNOWN_COMMAND, matching the curl pattern above. Project-level
  // dispatch is exercised by tests/bin.plan{07,09,10}.
  it('does not register screenshot/visual.diff/gen/test in buildCommands (plugin-only after LEV-165)', async () => {
    const reg = buildCommands('/tmp/levelzero-bin-smoke-registry.json');
    for (const argv of [
      ['screenshot', '--json'],
      ['visual', 'diff', '--json'],
      ['gen', '--json'],
      ['test', '--json'],
    ]) {
      const out = await runCli(argv, reg, { cwd: '/' });
      expect(out.exitCode, `expected ${argv[0]} to be UNKNOWN_COMMAND`).toBe(1);
      const parsed = JSON.parse(out.stderr);
      expect(parsed.code, `expected ${argv[0]} code`).toBe('UNKNOWN_COMMAND');
    }
  });
});
