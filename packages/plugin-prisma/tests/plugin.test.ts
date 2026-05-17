import { describe, it, expect, vi } from 'vitest';
import type {
  AdapterSlot,
  Command,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import plugin, { prismaAdapter } from '../src/index';

/**
 * Minimal `PluginAPI` recorder. Captures the (slot, name, impl) tuples passed
 * to `addAdapter` / `setActiveAdapter` and the `Command` objects passed to
 * `addCommand` — the only API methods this plugin uses today. The remaining
 * methods are vitest spies so accidental future calls show up in the
 * assertion surface rather than crashing silently.
 */
function makeRecordingApi(): {
  api: PluginAPI;
  adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }>;
  actives: Array<{ slot: AdapterSlot; name: string }>;
  commands: Command[];
} {
  const adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }> = [];
  const actives: Array<{ slot: AdapterSlot; name: string }> = [];
  const commands: Command[] = [];
  const api: PluginAPI = {
    addAdapter: (slot, name, impl) => {
      adapters.push({ slot, name, impl });
    },
    setActiveAdapter: (slot, name) => {
      actives.push({ slot, name });
    },
    addCommand: (cmd) => {
      commands.push(cmd);
    },
    addOwnedService: vi.fn(),
    addComposeService: vi.fn(),
    addComposeVolume: vi.fn(),
    addComposeNetwork: vi.fn(),
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
  };
  return { api, adapters, actives, commands };
}

describe('@levelzero/plugin-prisma default export', () => {
  it('exposes name + version + register', () => {
    expect(plugin.name).toBe('@levelzero/plugin-prisma');
    expect(typeof plugin.version).toBe('string');
    expect(typeof plugin.register).toBe('function');
  });

  it('register() contributes the prisma adapter under the orm slot', async () => {
    const { api, adapters, actives } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toEqual({ slot: 'orm', name: 'prisma', impl: prismaAdapter });
    expect(actives).toEqual([{ slot: 'orm', name: 'prisma' }]);
  });

  it('register() contributes the four db.* commands', async () => {
    const { api, commands } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual([
      'db.inspect',
      'db.migrate',
      'db.migration.new',
      'db.seed',
    ]);
    for (const cmd of commands) {
      expect(typeof cmd.describe).toBe('string');
      expect(typeof cmd.run).toBe('function');
    }
  });
});
