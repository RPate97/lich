import { describe, it, expect } from 'vitest';
import {
  groupCommands,
  groupKey,
  makeHelpCommand,
  orderGroupKeys,
  renderHelp,
  type LoadedPluginInfo,
} from '../../src/commands/help';
import { CommandRegistry } from '../../src/commands/registry';
import type { Command } from '../../src/commands/types';

function cmd(name: string, describe = 'does the thing'): Command {
  return { name, describe, async run() { return null; } };
}

function makeRegistry(commands: Command[]): CommandRegistry {
  const reg = new CommandRegistry();
  for (const c of commands) reg.register(c);
  return reg;
}

describe('groupKey', () => {
  it('puts dot-free names in the synthetic "core" group', () => {
    expect(groupKey('dev')).toBe('core');
    expect(groupKey('init')).toBe('core');
    expect(groupKey('check')).toBe('core');
  });

  it('uses the first dotted segment as the group key', () => {
    expect(groupKey('stacks.current')).toBe('stacks');
    expect(groupKey('adapter.swap')).toBe('adapter');
    expect(groupKey('env.list')).toBe('env');
  });

  it('collapses deeper namespaces to the top-level prefix', () => {
    expect(groupKey('db.migration.new')).toBe('db');
  });
});

describe('groupCommands', () => {
  it('buckets commands by group and sorts each bucket alphabetically', () => {
    const groups = groupCommands([
      cmd('stacks.list'),
      cmd('stacks.current'),
      cmd('up'),
      cmd('init'),
    ]);
    expect(Object.keys(groups).sort()).toEqual(['core', 'stacks']);
    expect(groups['core']!.map((c) => c.name)).toEqual(['init', 'up']);
    expect(groups['stacks']!.map((c) => c.name)).toEqual(['stacks.current', 'stacks.list']);
  });
});

describe('orderGroupKeys', () => {
  it('renders curated groups first in their declared order', () => {
    const groups = groupCommands([
      cmd('check'),
      cmd('db.migrate'),
      cmd('stacks.current'),
      cmd('adapter.list'),
      cmd('compose'),
    ]);
    const order = orderGroupKeys(groups);
    // Curated order from help.ts: core, adapter, stacks, compose, env, db, ...
    // The synthetic `core` group covers dot-free names (check + compose).
    expect(order).toEqual(['core', 'adapter', 'stacks', 'db']);
  });

  it('appends uncurated groups alphabetically after the curated set', () => {
    const groups = groupCommands([
      cmd('dev'),
      cmd('zebra.thing'),
      cmd('alpha.thing'),
      cmd('stacks.current'),
    ]);
    expect(orderGroupKeys(groups)).toEqual(['core', 'stacks', 'alpha', 'zebra']);
  });

  it('omits curated groups that have no commands', () => {
    const groups = groupCommands([cmd('dev')]);
    expect(orderGroupKeys(groups)).toEqual(['core']);
  });
});

describe('renderHelp', () => {
  it('includes the banner, USAGE block, every command with describe, and the trailing prompt', () => {
    const reg = makeRegistry([
      cmd('dev', 'Start services'),
      cmd('init', 'Scaffold a project'),
      cmd('stacks.current', 'Show current stack'),
    ]);
    const out = renderHelp(reg, []);
    expect(out).toContain('lich — extensible dev environment orchestrator');
    expect(out).toContain('USAGE');
    expect(out).toContain('CORE COMMANDS');
    expect(out).toContain('STACKS');
    expect(out).toContain('Start services');
    expect(out).toContain('Show current stack');
    expect(out).toContain('Run `lich <command>` to invoke a command.');
    // Trailing newline so direct write to stdout yields a clean prompt.
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders dotted command names with spaces (matches how users type them)', () => {
    const reg = makeRegistry([cmd('stacks.current', 'Show current stack')]);
    const out = renderHelp(reg, []);
    expect(out).toContain('stacks current');
    expect(out).not.toContain('stacks.current');
  });

  it('omits commands that have an empty describe (no orphan name-only rows)', () => {
    const reg = makeRegistry([
      cmd('dev', 'Start services'),
      cmd('mystery', ''),
    ]);
    const out = renderHelp(reg, []);
    expect(out).toContain('dev');
    expect(out).not.toMatch(/\bmystery\b/);
  });

  it('renders the empty-state message under LOADED PLUGINS when no plugins booted', () => {
    const reg = makeRegistry([cmd('dev', 'Start')]);
    const out = renderHelp(reg, []);
    expect(out).toContain('LOADED PLUGINS');
    expect(out).toContain('(no project plugins loaded — declare them in lich.config.ts)');
  });

  it('lists loaded plugins alphabetically with their version', () => {
    const reg = makeRegistry([cmd('dev', 'Start')]);
    const plugins: LoadedPluginInfo[] = [
      { name: '@lich/plugin-zeta', version: '0.2.0' },
      { name: '@lich/plugin-alpha', version: '1.0.0' },
    ];
    const out = renderHelp(reg, plugins);
    const alphaIdx = out.indexOf('@lich/plugin-alpha');
    const zetaIdx = out.indexOf('@lich/plugin-zeta');
    expect(alphaIdx).toBeGreaterThan(0);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
    expect(out).toContain('@lich/plugin-alpha (1.0.0)');
    expect(out).toContain('@lich/plugin-zeta (0.2.0)');
  });

  it('omits the version suffix when none is provided', () => {
    const reg = makeRegistry([cmd('dev', 'Start')]);
    const out = renderHelp(reg, [{ name: 'my-plugin' }]);
    expect(out).toMatch(/^ {2}my-plugin$/m);
    expect(out).not.toContain('my-plugin (');
  });

  it('does NOT hardcode a command list — a freshly-registered command appears automatically', () => {
    const reg = makeRegistry([
      cmd('dev', 'Start'),
      cmd('future.command', 'Hypothetical plugin contribution'),
    ]);
    const out = renderHelp(reg, []);
    expect(out).toContain('future command');
    expect(out).toContain('Hypothetical plugin contribution');
    expect(out).toContain('FUTURE');
  });
});

describe('makeHelpCommand', () => {
  it('exposes the standard Command shape with name "help"', () => {
    const command = makeHelpCommand({
      getRegistry: () => new CommandRegistry(),
      getLoadedPlugins: () => [],
    });
    expect(command.name).toBe('help');
    expect(typeof command.describe).toBe('string');
    expect(command.describe.length).toBeGreaterThan(0);
  });

  it('run() returns the rendered help string (NOT a structured object)', async () => {
    const reg = makeRegistry([cmd('dev', 'Start services')]);
    const command = makeHelpCommand({
      getRegistry: () => reg,
      getLoadedPlugins: () => [],
    });
    const out = await command.run({ cwd: '/', format: 'pretty', args: [], flags: {} });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('Start services');
  });

  it('re-reads the registry on each run() so commands registered after the factory call still appear', async () => {
    const reg = makeRegistry([cmd('dev', 'Start')]);
    const command = makeHelpCommand({
      getRegistry: () => reg,
      getLoadedPlugins: () => [],
    });
    reg.register(cmd('late', 'Registered after factory call'));
    const out = await command.run({ cwd: '/', format: 'pretty', args: [], flags: {} });
    expect(out as string).toContain('Registered after factory call');
  });
});
