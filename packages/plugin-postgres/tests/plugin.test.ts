import { describe, it, expect, vi } from 'vitest';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import postgres from '../src/index';

// LEV-186: the package now default-exports a factory. Instantiate once so the
// rest of the file keeps using `plugin.register(...)` exactly as before.
const plugin = postgres();

/**
 * Minimal `PluginAPI` recorder. Only the methods this plugin actually calls
 * need real behaviour — the rest are vitest spies so accidental future calls
 * surface in the assertion list rather than crashing the test.
 */
function makeRecordingApi(): {
  api: PluginAPI;
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
} {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const api: PluginAPI = {
    addAdapter: vi.fn(),
    setActiveAdapter: vi.fn(),
    addCommand: vi.fn(),
    addOwnedService: vi.fn(),
    addComposeService: (name, def) => {
      services[name] = def;
    },
    addComposeVolume: (name, def) => {
      volumes[name] = def;
    },
    addComposeNetwork: (name, def) => {
      networks[name] = def;
    },
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
    // Added by LEV-178 (`EnvSource` types + namespace-scoped `PluginAPI`).
    // Postgres will publish env sources here in LEV-186/187; for now the
    // mocks just satisfy the typed surface.
    addEnvSource: vi.fn(),
    addBulkEnvSource: vi.fn(),
  };
  return { api, services, volumes, networks };
}

describe('@levelzero/plugin-postgres default export', () => {
  it('exposes name + version + register', () => {
    expect(plugin.name).toBe('@levelzero/plugin-postgres');
    expect(typeof plugin.version).toBe('string');
    expect(typeof plugin.register).toBe('function');
  });

  it('register() contributes the postgres compose service', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(services)).toEqual(['postgres']);
    const pg = services.postgres!;
    expect(pg.image).toBe('postgres:16-alpine');
    expect(pg.ports).toEqual(['${PORT_postgres}:5432']);
    expect(pg.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
    expect(pg.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'pg_isready -U levelzero -d levelzero',
    ]);
  });

  it('register() contributes the pgdata named volume', async () => {
    const { api, volumes } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(volumes)).toEqual(['pgdata']);
    expect(volumes.pgdata).toEqual({});
  });

  it('register() does not contribute any networks', async () => {
    const { api, networks } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(networks)).toEqual([]);
  });
});
