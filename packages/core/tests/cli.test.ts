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
  it('dispatches to a top-level command and prints its result as JSON by default', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo'], makeRegistry([echo]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('{"said":"hi"}');
  });

  it('honors --pretty', async () => {
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
    const out = await runCli(['stacks', 'current'], makeRegistry([cur]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).stack).toBe('x');
  });

  it('returns a structured error when the command is unknown', async () => {
    const out = await runCli(['nope'], makeRegistry([]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });

  it('renders a CLIError raised by a command', async () => {
    const bad: Command = {
      name: 'bad',
      describe: 'bad',
      run: async () => {
        throw new CLIError('NO_PROJECT', 'not inside a levelzero project');
      },
    };
    const out = await runCli(['bad'], makeRegistry([bad]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stderr).code).toBe('NO_PROJECT');
  });

  // Smoke check for LEV-110: `curl` is registered in bin.ts. We invoke
  // through `buildCommands` with no args so the curl command's own
  // argument validation fires (CONFIG_INVALID), proving the dispatcher
  // resolved `curl` rather than returning UNKNOWN_COMMAND.
  it('registers the curl command in bin (not UNKNOWN_COMMAND)', async () => {
    const reg = buildCommands('/tmp/levelzero-bin-smoke-registry.json');
    const out = await runCli(['curl'], reg, { cwd: '/' });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).not.toBe('UNKNOWN_COMMAND');
    expect(parsed.code).toBe('CONFIG_INVALID');
  });
});
