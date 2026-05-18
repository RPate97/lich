import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetWarnedPlugins, promoteEnvContributions } from '../../src/env/compat';
import { bootPlugins } from '../../src/plugins/boot';
import { EnvSourceRegistry } from '../../src/env/registry';
import type { LevelzeroConfig } from '../../src/config';
import type { Plugin, PluginAPI } from '../../src/plugins/types';
import type { EnvSourceContext } from '../../src/env/types';
import type { DockerService, OwnedService } from '../../src/services/types';

const PROJECT_ROOT = '/tmp/lz-compat-test';

/**
 * Build a minimal {@link PluginAPI} backed by a real {@link EnvSourceRegistry}
 * so tests can assert on the actual collision behaviour the shim depends on.
 * Methods this suite doesn't exercise are stubbed with `vi.fn()`.
 */
function makeApi(namespace: string, pluginName: string, registry: EnvSourceRegistry): PluginAPI {
  return {
    addAdapter: vi.fn(),
    setActiveAdapter: vi.fn(),
    addCommand: vi.fn(),
    addOwnedService: vi.fn(),
    addComposeService: vi.fn(),
    addComposeVolume: vi.fn(),
    addComposeNetwork: vi.fn(),
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
    addEnvSource(name, source) {
      registry.registerNamed({
        namespace,
        name,
        fullKey: `${namespace}.${name}`,
        source,
        pluginName,
      });
    },
    addBulkEnvSource: vi.fn(),
  };
}

function makeCtx(overrides: Partial<EnvSourceContext> = {}): EnvSourceContext {
  return {
    ports: {},
    projectRoot: PROJECT_ROOT,
    worktreeKey: 'testkey',
    consumerContext: 'host',
    ...overrides,
  };
}

describe('promoteEnvContributions — direct usage', () => {
  // Use `any` to dodge vitest's MockInstance generic friction with
  // `console.warn`'s variadic signature; we only need the call assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(() => {
    _resetWarnedPlugins();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does nothing for services that lack envContributions', () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('redis', 'plugin-redis', registry);
    // OwnedService without envContributions: cast through `unknown` since the
    // type requires the field — the shim accepts the wider shape at runtime.
    const svc = { name: 'redis', kind: 'owned' as const } as unknown as OwnedService;

    promoteEnvContributions(svc, api, 'plugin-redis');

    expect(registry.listNamed()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('promotes each key from envContributions into a lowercased named source', () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('postgres', '@levelzero/plugin-postgres', registry);
    const svc: DockerService = {
      name: 'postgres',
      kind: 'docker',
      portNames: ['postgres'],
      image: 'postgres:16-alpine',
      envContributions: (ports) => ({
        DATABASE_URL: `postgres://u:p@localhost:${ports.postgres ?? 0}/db`,
        DATABASE_DIRECT_URL: `postgres://u:p@localhost:${ports.postgres ?? 0}/db?direct=1`,
      }),
    };

    promoteEnvContributions(svc, api, '@levelzero/plugin-postgres');

    const url = registry.getNamed('postgres.database_url');
    const direct = registry.getNamed('postgres.database_direct_url');
    expect(url).toBeDefined();
    expect(direct).toBeDefined();
  });

  it('host and container resolvers both forward to envContributions', async () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('postgres', '@levelzero/plugin-postgres', registry);
    const svc: DockerService = {
      name: 'postgres',
      kind: 'docker',
      portNames: ['postgres'],
      image: 'postgres:16-alpine',
      envContributions: (ports) => ({
        DATABASE_URL: `postgres://u:p@localhost:${ports.postgres}/db`,
      }),
    };

    promoteEnvContributions(svc, api, '@levelzero/plugin-postgres');

    const entry = registry.getNamed('postgres.database_url');
    expect(entry).toBeDefined();
    const ctx = makeCtx({ ports: { postgres: 54321 } });
    expect(entry!.source.host(ctx)).toBe('postgres://u:p@localhost:54321/db');
    expect(entry!.source.container({ ...ctx, consumerContext: 'container' })).toBe(
      'postgres://u:p@localhost:54321/db',
    );
  });

  it('emits exactly one deprecation warning per plugin name', () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('ns', 'plugin-x', registry);
    const svcA: OwnedService = {
      name: 'a',
      kind: 'owned',
      portNames: ['a'],
      cwd: '.',
      command: 'noop',
      envContributions: () => ({ A: 'a' }),
    };
    const svcB: OwnedService = {
      name: 'b',
      kind: 'owned',
      portNames: ['b'],
      cwd: '.',
      command: 'noop',
      envContributions: () => ({ B: 'b' }),
    };

    promoteEnvContributions(svcA, api, 'plugin-x');
    promoteEnvContributions(svcB, api, 'plugin-x');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('plugin-x');
    expect(msg).toContain('Service.envContributions');
  });

  it('emits a separate warning for each distinct plugin name', () => {
    const registry = new EnvSourceRegistry();
    const apiX = makeApi('x', 'plugin-x', registry);
    const apiY = makeApi('y', 'plugin-y', registry);
    const mkSvc = (name: string, key: string): OwnedService => ({
      name,
      kind: 'owned',
      portNames: [name],
      cwd: '.',
      command: 'noop',
      envContributions: () => ({ [key]: 'v' }),
    });

    promoteEnvContributions(mkSvc('a', 'A'), apiX, 'plugin-x');
    promoteEnvContributions(mkSvc('b', 'B'), apiY, 'plugin-y');

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('silently skips a key the plugin already registered via addEnvSource', () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('postgres', '@levelzero/plugin-postgres', registry);
    // Plugin migrated this key already (LEV-187 case).
    api.addEnvSource('database_url', {
      host: () => 'explicit-host',
      container: () => 'explicit-container',
    });
    const svc: DockerService = {
      name: 'postgres',
      kind: 'docker',
      portNames: ['postgres'],
      image: 'postgres:16-alpine',
      envContributions: () => ({ DATABASE_URL: 'legacy-value' }),
    };

    // Should NOT throw — the duplicate is interpreted as "already migrated".
    expect(() => promoteEnvContributions(svc, api, '@levelzero/plugin-postgres')).not.toThrow();

    const entry = registry.getNamed('postgres.database_url');
    expect(entry).toBeDefined();
    // The explicit (first) registration wins.
    expect(entry!.source.host(makeCtx())).toBe('explicit-host');
    expect(registry.listNamed()).toHaveLength(1);
  });

  it('still emits the deprecation warning even when no keys can be promoted', () => {
    const registry = new EnvSourceRegistry();
    const api = makeApi('throws', 'plugin-throws', registry);
    const svc: OwnedService = {
      name: 'thrower',
      kind: 'owned',
      portNames: ['thrower'],
      cwd: '.',
      command: 'noop',
      // Touches a port property — throws when called with `{}` during sampling.
      envContributions: (ports) => ({
        URL: `http://x:${(ports as unknown as { thrower: { port: number } }).thrower.port}`,
      }),
    };

    promoteEnvContributions(svc, api, 'plugin-throws');

    expect(registry.listNamed()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('promoteEnvContributions — wired through bootPlugins', () => {
  // Use `any` to dodge vitest's MockInstance generic friction with
  // `console.warn`'s variadic signature; we only need the call assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(() => {
    _resetWarnedPlugins();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('promotes envContributions on a legacy OwnedService at boot', async () => {
    const legacy: Plugin = {
      name: '@levelzero/plugin-legacy',
      version: '0.0.1',
      register(api) {
        const svc: OwnedService = {
          name: 'web',
          kind: 'owned',
          portNames: ['web'],
          cwd: '.',
          command: 'bun run dev',
          envContributions: (ports) => ({
            WEB_URL: `http://localhost:${ports.web ?? 0}`,
          }),
        };
        api.addOwnedService(svc);
      },
    };

    const result = await bootPlugins({ plugins: [legacy] } as LevelzeroConfig, PROJECT_ROOT);
    // Namespace auto-derives from the package name — the loader's
    // `deriveNamespace` strips the `@scope/plugin-` prefix from
    // `@levelzero/plugin-legacy` to yield `legacy`.
    const entry = result.envSources.getNamed('legacy.web_url');
    expect(entry).toBeDefined();
    expect(entry!.source.host(makeCtx({ ports: { web: 8080 } }))).toBe(
      'http://localhost:8080',
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit addEnvSource win over the legacy auto-promotion', async () => {
    const mixed: Plugin<'mix'> = {
      name: '@levelzero/plugin-mix',
      namespace: 'mix',
      version: '0.0.1',
      register(api) {
        // Explicit migration: register the new-style source first.
        api.addEnvSource('url', {
          host: () => 'new-host',
          container: () => 'new-container',
        });
        // Then add the legacy service — the shim's duplicate registration
        // should be silently swallowed.
        const svc: OwnedService = {
          name: 'app',
          kind: 'owned',
          portNames: ['app'],
          cwd: '.',
          command: 'noop',
          envContributions: () => ({ URL: 'old-value' }),
        };
        api.addOwnedService(svc);
      },
    };

    const result = await bootPlugins({ plugins: [mixed] } as LevelzeroConfig, PROJECT_ROOT);
    const entry = result.envSources.getNamed('mix.url');
    expect(entry).toBeDefined();
    expect(entry!.source.host(makeCtx())).toBe('new-host');
    expect(result.envSources.listNamed()).toHaveLength(1);
  });
});
