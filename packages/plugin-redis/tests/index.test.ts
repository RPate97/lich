import { describe, it, expect, vi } from 'vitest';
import type {
  AdapterSlot,
  Command,
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  EnvSource,
  EnvSourceContext,
  PluginAPI,
  PluginContext,
} from '@lich/core';
import redis, {
  redisCacheAdapter,
  redisComposeService,
  redisPingCommand,
} from '../src/index';

/**
 * Minimal `PluginAPI` recorder for the redis plugin. Captures every
 * contribution surface the plugin currently uses (compose service, named
 * env sources, portless adapter, command) so we can assert on what
 * `register()` did. Unused methods are spies — accidental new calls show
 * up in the assertion surface rather than crashing the recorder.
 */
function makeRecordingApi(): {
  api: PluginAPI<'redis'>;
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
  envSources: Record<string, EnvSource>;
  adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }>;
  actives: Array<{ slot: AdapterSlot; name: string }>;
  commands: Command[];
} {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
  const adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }> = [];
  const actives: Array<{ slot: AdapterSlot; name: string }> = [];
  const commands: Command[] = [];
  const api: PluginAPI<'redis'> = {
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
  return { api, services, volumes, networks, envSources, adapters, actives, commands };
}

/**
 * Construct an `EnvSourceContext` with sane defaults for resolver tests.
 * `consumerContext` is irrelevant for named sources (the framework picks
 * `host` vs `container` by service kind), but the type requires it; pick
 * `'host'` arbitrarily.
 */
function makeCtx(overrides: Partial<EnvSourceContext> = {}): EnvSourceContext {
  return {
    ports: { redis: 51234 },
    projectRoot: '/tmp/example',
    worktreeKey: 'abc12345',
    consumerContext: 'host',
    ...overrides,
  };
}

describe('@lich/plugin-redis factory (LEV-190)', () => {
  it('produces a Plugin with the canonical name + namespace + version', () => {
    const plugin = redis();
    expect(plugin.name).toBe('@lich/plugin-redis');
    expect(plugin.namespace).toBe('redis');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('honors an explicit namespace override', () => {
    const plugin = redis({ namespace: 'cache' });
    expect(plugin.namespace).toBe('cache');
  });

  it('contributes the redis compose service with the documented shape', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    expect(Object.keys(services)).toEqual(['redis']);
    const r = services.redis!;
    expect(r.image).toBe('redis:7-alpine');
    expect(r.ports).toEqual(['${PORT_redis}:6379']);
    expect(r.healthcheck?.test).toEqual(['CMD', 'redis-cli', 'ping']);
    // No password set → no `command` override.
    expect((r as ComposeServiceDef & { command?: string[] }).command).toBeUndefined();
  });

  it('allows the compose image to be overridden', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis({ image: 'redis:7.2-alpine' }).register(api, ctx);
    expect(services.redis!.image).toBe('redis:7.2-alpine');
  });

  it('switches to `--requirepass` mode when a password is configured', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis({ password: 'hunter2' }).register(api, ctx);
    const r = services.redis as ComposeServiceDef & { command?: string[] };
    expect(r.command).toEqual(['redis-server', '--requirepass', 'hunter2']);
  });

  it('publishes the five named EnvSources under the `redis` namespace', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    // The framework composes `redis.<name>` from the namespace; at the API
    // surface the plugin only sees the short names.
    expect(Object.keys(envSources).sort()).toEqual([
      'driver',
      'host',
      'password',
      'port',
      'url',
    ]);
  });

  it('resolves host vs container values correctly for url/host/port', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    const ctxIn = makeCtx({ ports: { redis: 51234 } });

    // host resolvers — host process sees `localhost:<allocated-port>`.
    expect(await envSources.host!.host(ctxIn)).toBe('localhost');
    expect(await envSources.port!.host(ctxIn)).toBe('51234');
    expect(await envSources.url!.host(ctxIn)).toBe('redis://localhost:51234');

    // container resolvers — sibling compose services hit compose DNS.
    expect(await envSources.host!.container(ctxIn)).toBe('redis');
    expect(await envSources.port!.container(ctxIn)).toBe('6379');
    expect(await envSources.url!.container(ctxIn)).toBe('redis://redis:6379');
  });

  it('stamps `url` with the `redis` protocol tag', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);
    expect(envSources.url!.protocol).toBe('redis');
  });

  it('resolves driver to the literal string `redis` on both sides', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    const ctxIn = makeCtx();
    expect(await envSources.driver!.host(ctxIn)).toBe('redis');
    expect(await envSources.driver!.container(ctxIn)).toBe('redis');
  });

  it('threads the password into url userinfo and the password source', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis({ password: 'sup3rsecret' }).register(api, ctx);

    const ctxIn = makeCtx({ ports: { redis: 51234 } });
    expect(await envSources.password!.host(ctxIn)).toBe('sup3rsecret');
    expect(await envSources.password!.container(ctxIn)).toBe('sup3rsecret');
    expect(await envSources.url!.host(ctxIn)).toBe(
      'redis://:sup3rsecret@localhost:51234',
    );
    expect(await envSources.url!.container(ctxIn)).toBe(
      'redis://:sup3rsecret@redis:6379',
    );
  });

  it('defaults password to empty string when not set (no userinfo segment)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    const ctxIn = makeCtx();
    expect(await envSources.password!.host(ctxIn)).toBe('');
    expect(await envSources.password!.container(ctxIn)).toBe('');
  });

  it('preserves the portless `redis-cache` adapter contribution', async () => {
    const { api, adapters, actives } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    expect(adapters).toEqual([
      { slot: 'portless', name: 'redis-cache', impl: redisCacheAdapter },
    ]);
    expect(actives).toEqual([{ slot: 'portless', name: 'redis-cache' }]);
  });

  it('preserves the redis.ping command contribution', async () => {
    const { api, commands } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('redis.ping');
    expect(commands[0]).toBe(redisPingCommand);
  });

  it('does not contribute any compose volumes or networks', async () => {
    const { api, volumes, networks } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await redis().register(api, ctx);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
  });

  it('re-exports the base compose service for tests + tooling', () => {
    expect(redisComposeService.image).toBe('redis:7-alpine');
  });
});
