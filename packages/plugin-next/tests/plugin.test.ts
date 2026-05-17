import { describe, it, expect, vi } from 'vitest';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  OwnedService,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import plugin, { webService } from '../src/index';

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
} {
  const ownedServices: OwnedService[] = [];
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
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
  };
  return { api, ownedServices, services, volumes, networks };
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
    expect(web.envContributions({ 'web-http': 3002 }).WEB_URL).toBe(
      'http://localhost:3002',
    );
  });

  it('register() does not contribute compose services, volumes, or networks', async () => {
    const { api, services, volumes, networks } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await plugin.register(api, ctx);

    expect(Object.keys(services)).toEqual([]);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
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
    expect(webService.envContributions({ 'web-http': 3002 }).WEB_URL).toBe(
      'http://localhost:3002',
    );
  });
});
