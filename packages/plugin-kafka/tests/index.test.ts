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
} from '@levelzero/core';
import kafka from '../src/index';

/**
 * Minimal `PluginAPI` recorder for the kafka plugin. Captures every
 * contribution surface the plugin currently uses (compose service, named
 * env sources). Unused methods are spies so accidental new calls show up
 * in the assertion surface rather than crashing the recorder.
 */
function makeRecordingApi(): {
  api: PluginAPI<'kafka'>;
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
  const api: PluginAPI<'kafka'> = {
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
    ports: { kafka: 51234 },
    projectRoot: '/tmp/example',
    worktreeKey: 'abc12345',
    consumerContext: 'host',
    ...overrides,
  };
}

describe('@levelzero/plugin-kafka factory (LEV-191)', () => {
  it('produces a Plugin with the canonical name + namespace + version', () => {
    const plugin = kafka();
    expect(plugin.name).toBe('@levelzero/plugin-kafka');
    expect(plugin.namespace).toBe('kafka');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('honors an explicit namespace override', () => {
    const plugin = kafka({ namespace: 'events' });
    expect(plugin.namespace).toBe('events');
  });

  it('contributes the kafka compose service with the documented KRaft shape', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    expect(Object.keys(services)).toEqual(['kafka']);
    const k = services.kafka!;
    expect(k.image).toBe('confluentinc/cp-kafka:7.6.0');
    expect(k.ports).toEqual(['${PORT_kafka}:9092']);
    expect(k.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'kafka-broker-api-versions --bootstrap-server localhost:9092 || exit 1',
    ]);
    expect(k.healthcheck?.interval).toBe('10s');
    expect(k.healthcheck?.retries).toBe(12);
    expect(k.healthcheck?.start_period).toBe('20s');
  });

  it('configures KRaft-mode environment (no Zookeeper)', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    const env = services.kafka!.environment!;
    // KRaft opt-in
    expect(env.KAFKA_PROCESS_ROLES).toBe('broker,controller');
    expect(env.KAFKA_NODE_ID).toBe('1');
    expect(env.KAFKA_CONTROLLER_QUORUM_VOTERS).toBe('1@kafka:9093');
    // Listener wiring
    expect(env.KAFKA_LISTENERS).toBe(
      'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
    );
    expect(env.KAFKA_ADVERTISED_LISTENERS).toBe('PLAINTEXT://kafka:9092');
    expect(env.KAFKA_INTER_BROKER_LISTENER_NAME).toBe('PLAINTEXT');
    expect(env.KAFKA_CONTROLLER_LISTENER_NAMES).toBe('CONTROLLER');
    expect(env.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP).toBe(
      'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
    );
    // Single-node replication factors
    expect(env.KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR).toBe('1');
    expect(env.KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR).toBe('1');
    expect(env.KAFKA_TRANSACTION_STATE_LOG_MIN_ISR).toBe('1');
    // Stable cluster identifier
    expect(env.CLUSTER_ID).toBe('levelzero-kafka-dev');
    // Zookeeper-mode fields must NOT be present in KRaft setup
    expect(env.KAFKA_ZOOKEEPER_CONNECT).toBeUndefined();
  });

  it('allows the compose image to be overridden', async () => {
    const { api, services } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka({ image: 'confluentinc/cp-kafka:7.7.0' }).register(api, ctx);
    expect(services.kafka!.image).toBe('confluentinc/cp-kafka:7.7.0');
  });

  it('publishes the four named EnvSources under the `kafka` namespace', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    // The framework composes `kafka.<name>` from the namespace; at the API
    // surface the plugin only sees the short names.
    expect(Object.keys(envSources).sort()).toEqual([
      'bootstrap_servers',
      'driver',
      'host',
      'port',
    ]);
  });

  it('resolves host vs container values correctly for host/port', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    const ctxIn = makeCtx({ ports: { kafka: 51234 } });

    // host resolvers — host process sees `localhost:<allocated-port>`.
    expect(await envSources.host!.host(ctxIn)).toBe('localhost');
    expect(await envSources.port!.host(ctxIn)).toBe('51234');

    // container resolvers — sibling compose services hit compose DNS.
    expect(await envSources.host!.container(ctxIn)).toBe('kafka');
    expect(await envSources.port!.container(ctxIn)).toBe('9092');
  });

  it('resolves driver to the literal string `kafka` on both sides', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    const ctxIn = makeCtx();
    expect(await envSources.driver!.host(ctxIn)).toBe('kafka');
    expect(await envSources.driver!.container(ctxIn)).toBe('kafka');
  });

  it('publishes `bootstrap_servers` as a `host:port` list (NOT a URL)', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    const ctxIn = makeCtx({ ports: { kafka: 51234 } });
    const hostValue = await envSources.bootstrap_servers!.host(ctxIn);
    const containerValue = await envSources.bootstrap_servers!.container(ctxIn);

    expect(hostValue).toBe('localhost:51234');
    expect(containerValue).toBe('kafka:9092');

    // Load-bearing assertion: the value is NOT a URL. The whole point of
    // the kafka plugin is to prove the EnvSource design works for
    // non-URL connection strings. Guard against accidental regression to
    // a `kafka://…` URL shape.
    expect(hostValue.startsWith('kafka://')).toBe(false);
    expect(containerValue.startsWith('kafka://')).toBe(false);
    expect(hostValue).not.toContain('://');
    expect(containerValue).not.toContain('://');
  });

  it('tags `bootstrap_servers` with the `kafka` protocol', async () => {
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);
    expect(envSources.bootstrap_servers!.protocol).toBe('kafka');
  });

  it('returns an empty port segment when the stack allocator has no kafka entry', async () => {
    // Defensive: under normal operation the allocator always provides a
    // port, but guard against silently emitting `undefined` if it doesn't.
    const { api, envSources } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    const ctxIn = makeCtx({ ports: {} });
    expect(await envSources.port!.host(ctxIn)).toBe('');
    expect(await envSources.bootstrap_servers!.host(ctxIn)).toBe('localhost:');
  });

  it('does not contribute adapters, commands, volumes, or networks', async () => {
    const { api, adapters, actives, commands, volumes, networks } =
      makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await kafka().register(api, ctx);

    expect(adapters).toEqual([]);
    expect(actives).toEqual([]);
    expect(commands).toEqual([]);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
  });
});
