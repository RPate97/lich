import { describe, it, expect, vi } from 'vitest';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  EnvSource,
  EnvSourceContext,
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
  envSources: Record<string, EnvSource>;
} {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
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
    addEnvSource: (name, source) => {
      envSources[name] = source;
    },
    addBulkEnvSource: vi.fn(),
  };
  return { api, services, volumes, networks, envSources };
}

function makeEnvCtx(
  ports: Record<string, number>,
  consumerContext: 'host' | 'container' = 'host',
): EnvSourceContext {
  return {
    ports,
    projectRoot: '/tmp/example',
    worktreeKey: 'abc123',
    consumerContext,
  };
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

  it('register() publishes the full postgres EnvSource manifest (LEV-187)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(envSources).sort()).toEqual([
      'database',
      'driver',
      'host',
      'password',
      'port',
      'url',
      'user',
    ]);
  });

  it('host-context EnvSource resolvers build localhost values from the allocated port', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    const ec = makeEnvCtx({ postgres: 54123 }, 'host');
    expect(await envSources.host!.host(ec)).toBe('localhost');
    expect(await envSources.port!.host(ec)).toBe('54123');
    expect(await envSources.user!.host(ec)).toBe('levelzero');
    expect(await envSources.password!.host(ec)).toBe('levelzero');
    expect(await envSources.database!.host(ec)).toBe('levelzero');
    expect(await envSources.driver!.host(ec)).toBe('postgresql');
    expect(await envSources.url!.host(ec)).toBe(
      'postgres://levelzero:levelzero@localhost:54123/levelzero',
    );
  });

  it('container-context EnvSource resolvers route through compose DNS at port 5432', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    const ec = makeEnvCtx({ postgres: 54123 }, 'container');
    expect(await envSources.host!.container(ec)).toBe('postgres');
    expect(await envSources.port!.container(ec)).toBe('5432');
    expect(await envSources.url!.container(ec)).toBe(
      'postgres://levelzero:levelzero@postgres:5432/levelzero',
    );
  });

  it('url EnvSource declares the postgres protocol', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);
    expect(envSources.url!.protocol).toBe('postgres');
  });
});
