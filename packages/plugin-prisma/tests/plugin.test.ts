import { describe, it, expect, vi } from 'vitest';
import type {
  AdapterSlot,
  Command,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import { EnvSourceRegistry } from '@levelzero/core/env/registry';
import prisma, { prismaAdapter } from '../src/index';

// LEV-186: the package now default-exports a factory. Instantiate once so the
// rest of the file keeps using `plugin.register(...)` exactly as before.
const plugin = prisma();

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
    // Added by LEV-178 (`EnvSource` types + namespace-scoped `PluginAPI`).
    // Prisma doesn't publish env sources today; mocks satisfy the typed
    // surface so the recorder still constructs.
    addEnvSource: vi.fn(),
    addBulkEnvSource: vi.fn(),
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

  it('register() typechecks against a PluginContext WITHOUT getEnvSourceRegistry (backwards-compat)', async () => {
    // Synthetic PluginContext literals authored before LEV-171 don't carry
    // `getEnvSourceRegistry`. The factory must still construct cleanly —
    // command construction never throws, even when the boot wiring is
    // absent. (Runtime invocation surfaces a CLIError instead, which is
    // covered in `commands/migrate.test.ts`.)
    const { api, commands } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);
    expect(commands).toHaveLength(4);
  });

  it('register() threads PluginContext.getEnvSourceRegistry into command factories (LEV-171)', async () => {
    // When the host plumbed `getEnvSourceRegistry` through PluginContext,
    // the four db.* commands must close over it. The closure is called
    // lazily at command-run time, not during register — proving with this
    // test that:
    //  (a) construction succeeds when the getter is present, and
    //  (b) the getter is NOT invoked eagerly during register.
    const { api, commands } = makeRecordingApi();
    const envRegistry = new EnvSourceRegistry();
    let registryCalls = 0;
    const ctx: PluginContext = {
      projectRoot: '/tmp/example',
      config: {},
      getEnvSourceRegistry: () => {
        registryCalls++;
        return envRegistry;
      },
    };
    await plugin.register(api, ctx);

    expect(commands).toHaveLength(4);
    // Eager-invocation guard: the registry getter is only valuable when
    // resolved at command-run time, after every plugin has had a chance to
    // contribute its sources. Calling it during register would lock in a
    // partial view.
    expect(registryCalls).toBe(0);
  });
});
