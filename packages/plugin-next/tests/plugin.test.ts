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
import next, { webService } from '../src/index';

// LEV-186: the package now default-exports a factory. Instantiate once so the
// rest of the file keeps using `plugin.register(...)` exactly as before.
const plugin = next();

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
} {
  const ownedServices: OwnedService[] = [];
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
  const api: PluginAPI = {
    addAdapter: vi.fn(),
    setActiveAdapter: vi.fn(),
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
  return { api, ownedServices, services, volumes, networks, envSources };
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

describe('@levelzero/plugin-next default export', () => {
  it('exposes name + version + register', () => {
    expect(plugin.name).toBe('@levelzero/plugin-next');
    expect(typeof plugin.version).toBe('string');
    expect(typeof plugin.register).toBe('function');
  });

  it('register() contributes the web owned service', async () => {
    const { api, ownedServices } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(ownedServices).toHaveLength(1);
    const web = ownedServices[0]!;
    expect(web.name).toBe('web');
    expect(web.kind).toBe('owned');
    expect(web.portNames).toEqual(['web-http']);
    expect(web.cwd).toBe('apps/web');
    expect(web.command).toBe('bun run dev');
    expect(web.dependsOn).toEqual(['api']);
    expect(web.urlName).toBe('web');
  });

  it('register() does not contribute compose services, volumes, or networks', async () => {
    const { api, services, volumes, networks } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(services)).toEqual([]);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
  });

  it('register() publishes a `url` EnvSource (LEV-187)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(envSources).sort()).toEqual(['port', 'url']);
    expect(envSources.url!.protocol).toBe('http');

    const ec = makeEnvCtx({ 'web-http': 3002 }, 'host');
    expect(await envSources.url!.host(ec)).toBe('http://localhost:3002');
    expect(await envSources.url!.container(makeEnvCtx({ 'web-http': 3002 }, 'container'))).toBe(
      'http://web:3000',
    );
  });

  // LEV-200 — `next dev` does NOT read PORT from env; it requires `--port <n>`
  // on the CLI. The web template's `dev` script substitutes `$WEB_PORT` into
  // the command, so this plugin must publish the host-allocated port for
  // `envInjection: { WEB_PORT: 'next.port' }` to resolve.
  it('register() publishes a `port` EnvSource (LEV-200)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(envSources.port).toBeDefined();
    expect(await envSources.port!.host(makeEnvCtx({ 'web-http': 54001 }, 'host'))).toBe(
      '54001',
    );
    expect(
      await envSources.port!.container(makeEnvCtx({ 'web-http': 54001 }, 'container')),
    ).toBe('3000');
  });
});

describe('webService re-export', () => {
  it('matches the OwnedService shape `register()` contributes', () => {
    expect(webService.name).toBe('web');
    expect(webService.kind).toBe('owned');
    expect(webService.portNames).toEqual(['web-http']);
    expect(webService.cwd).toBe('apps/web');
    expect(webService.command).toBe('bun run dev');
    expect(webService.dependsOn).toEqual(['api']);
    expect(webService.urlName).toBe('web');
  });

  it('no longer carries an envContributions field (replaced by addEnvSource in LEV-187)', () => {
    // The legacy `envContributions(ports)` shape was removed when the plugin
    // migrated to explicit `api.addEnvSource('url', …)` in `register()`.
    expect(webService.envContributions).toBeUndefined();
  });
});
