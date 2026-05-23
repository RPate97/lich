import { describe, it, expect, vi } from 'vitest';
import type {
  AdapterSlot,
  Generator,
  PluginAPI,
  PluginContext,
} from '@lich/core';
import typedClient, {
  typedClientFrontendAdapter,
  apiClientGenerator,
} from '../src/index';

// LEV-186: the package default-exports a factory. Instantiate once so the
// rest of the file keeps using `plugin.register(...)` exactly as before.
const plugin = typedClient();

/**
 * Recording `PluginAPI`. Captures the (slot, name, impl) tuples passed to
 * `addAdapter` / `setActiveAdapter` and the `Generator` objects passed to
 * `addGenerator` — the only API methods this plugin uses today. The
 * remaining methods are spies so an accidental future call shows up in the
 * assertion surface rather than crashing silently.
 */
function makeRecordingApi(): {
  api: PluginAPI;
  adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }>;
  actives: Array<{ slot: AdapterSlot; name: string }>;
  generators: Generator[];
} {
  const adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }> = [];
  const actives: Array<{ slot: AdapterSlot; name: string }> = [];
  const generators: Generator[] = [];
  const api: PluginAPI = {
    addAdapter: (slot, name, impl) => {
      adapters.push({ slot, name, impl });
    },
    setActiveAdapter: (slot, name) => {
      actives.push({ slot, name });
    },
    addCommand: vi.fn(),
    addOwnedService: vi.fn(),
    addComposeService: vi.fn(),
    addComposeVolume: vi.fn(),
    addComposeNetwork: vi.fn(),
    addRule: vi.fn(),
    addGenerator: (gen) => {
      generators.push(gen);
    },
    addSkillsDir: vi.fn(),
    addEnvSource: vi.fn(),
    addBulkEnvSource: vi.fn(),
  };
  return { api, adapters, actives, generators };
}

describe('@lich/plugin-typed-client default export', () => {
  it('exposes name + version + register', () => {
    expect(plugin.name).toBe('@lich/plugin-typed-client');
    expect(typeof plugin.version).toBe('string');
    expect(typeof plugin.register).toBe('function');
  });

  it('register() contributes the typed-client adapter under the frontend slot', async () => {
    const { api, adapters, actives } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toEqual({
      slot: 'frontend',
      name: 'typed-client',
      impl: typedClientFrontendAdapter,
    });
    expect(actives).toEqual([{ slot: 'frontend', name: 'typed-client' }]);
  });

  it('register() contributes the api-client generator (LEV-124)', async () => {
    const { api, generators } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(generators).toHaveLength(1);
    const gen = generators[0]!;
    expect(gen.id).toBe('api-client');
    expect(typeof gen.describe).toBe('string');
    expect(typeof gen.generate).toBe('function');
    // The exported pre-built instance is the exact one the plugin registers
    // — keeps re-export and registration in sync without extra wrapping.
    expect(gen).toBe(apiClientGenerator);
  });
});
