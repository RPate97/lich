import { describe, it, expect, vi } from 'vitest';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  EnvSource,
  EnvSourceContext,
  OwnedService,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import hono, { apiService } from '../src/index';

// LEV-186: the package now default-exports a factory. Instantiate once so the
// rest of the file keeps using `plugin.register(...)` exactly as before.
const plugin = hono();

/**
 * Minimal `PluginAPI` recorder. Only the methods this plugin actually calls
 * need real behaviour — the rest are vitest spies so accidental future calls
 * surface in the assertion list rather than crashing the test.
 */
function makeRecordingApi(): {
  api: PluginAPI;
  ownedServices: OwnedService[];
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
  envSources: Record<string, EnvSource>;
  adapters: Array<[string, string]>;
  activeAdapters: Array<[string, string]>;
} {
  const ownedServices: OwnedService[] = [];
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
  const adapters: Array<[string, string]> = [];
  const activeAdapters: Array<[string, string]> = [];
  const api: PluginAPI = {
    addAdapter: (slot, name, _impl) => {
      adapters.push([slot, name]);
    },
    setActiveAdapter: (slot, name) => {
      activeAdapters.push([slot, name]);
    },
    addCommand: vi.fn(),
    addOwnedService: (svc) => {
      ownedServices.push(svc);
    },
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
  return { api, ownedServices, services, volumes, networks, envSources, adapters, activeAdapters };
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

describe('@levelzero/plugin-hono default export', () => {
  it('exposes name + version + register', () => {
    expect(plugin.name).toBe('@levelzero/plugin-hono');
    expect(typeof plugin.version).toBe('string');
    expect(typeof plugin.register).toBe('function');
  });

  it('register() registers the hono backend adapter and marks it active', async () => {
    const { api, adapters, activeAdapters } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(adapters).toEqual([['backend', 'hono']]);
    expect(activeAdapters).toEqual([['backend', 'hono']]);
  });

  it('register() contributes the api owned service (LEV-187)', async () => {
    const { api, ownedServices } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(ownedServices).toHaveLength(1);
    const apiSvc = ownedServices[0]!;
    expect(apiSvc.name).toBe('api');
    expect(apiSvc.kind).toBe('owned');
    expect(apiSvc.portNames).toEqual(['api-http']);
    expect(apiSvc.cwd).toBe('apps/api');
    expect(apiSvc.command).toBe('bun run dev');
    expect(apiSvc.dependsOn).toEqual(['postgres']);
    expect(apiSvc.urlName).toBe('api');
  });

  it('register() publishes a `url` EnvSource (LEV-187)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(envSources).sort()).toEqual(['port', 'url']);
    expect(envSources.url!.protocol).toBe('http');

    expect(await envSources.url!.host(makeEnvCtx({ 'api-http': 3001 }, 'host'))).toBe(
      'http://localhost:3001',
    );
    expect(
      await envSources.url!.container(makeEnvCtx({ 'api-http': 3001 }, 'container')),
    ).toBe('http://api:3000');
  });

  // LEV-200 — the api template needs the allocated host port (not just the
  // URL) so it can pass it to bun's `port` export on the Hono app. Container
  // context is unconditional `'3000'` because a future containerized api
  // would listen on the standard internal port.
  it('register() publishes a `port` EnvSource (LEV-200)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(envSources.port).toBeDefined();
    expect(
      await envSources.port!.host(makeEnvCtx({ 'api-http': 54000 }, 'host')),
    ).toBe('54000');
    expect(
      await envSources.port!.container(makeEnvCtx({ 'api-http': 54000 }, 'container')),
    ).toBe('3000');
  });
});

describe('apiService re-export', () => {
  it('matches the OwnedService shape `register()` contributes', () => {
    expect(apiService.name).toBe('api');
    expect(apiService.kind).toBe('owned');
    expect(apiService.portNames).toEqual(['api-http']);
    expect(apiService.cwd).toBe('apps/api');
    expect(apiService.command).toBe('bun run dev');
    expect(apiService.dependsOn).toEqual(['postgres']);
    expect(apiService.urlName).toBe('api');
  });

  it('no longer carries an envContributions field (LEV-187)', () => {
    expect(apiService.envContributions).toBeUndefined();
  });
});
