import type {
  ComposeServiceDef,
  Plugin,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';

/**
 * Options accepted by the `@levelzero/plugin-kafka` factory.
 *
 *  - `image`     — Docker image tag, defaults to `confluentinc/cp-kafka:7.6.0`.
 *  - `namespace` — override the default `kafka` namespace if a project
 *                  needs to run two kafka plugins side-by-side. Rarely
 *                  needed; the type-system tag `'kafka'` keeps autocomplete
 *                  sharp for the common case.
 */
export interface KafkaOptions {
  image?: string;
  namespace?: string;
}

/**
 * `@levelzero/plugin-kafka` (LEV-191).
 *
 * Validates that the EnvSource design accommodates **non-URL** connection
 * strings. Kafka clients do not consume a `kafka://host:port/path`-shaped
 * URL — they take a comma-separated `host:port,host:port,…` bootstrap list
 * (and conventionally configure the protocol/auth on the client itself).
 * Publishing that as `kafka.bootstrap_servers` proves the framework treats
 * named EnvSources as opaque strings — no core change is required to add a
 * new protocol shape.
 *
 * Compose service: single-node Kafka 7.6 in **KRaft** mode (no Zookeeper).
 * The broker plays both roles (`broker,controller`) and bootstraps a
 * one-node controller quorum. `KAFKA_ADVERTISED_LISTENERS` advertises
 * `kafka:9092` so sibling compose services can hit the broker by compose
 * DNS; the host port is allocated by the stack allocator and surfaced as
 * `${PORT_kafka}:9092`.
 *
 * Contributions on each invocation:
 *
 *   1. `addComposeService('kafka', …)` — KRaft single-node broker on a
 *      stack-allocated host port with a `kafka-broker-api-versions`
 *      healthcheck so downstream services can `depends_on:
 *      { kafka: { condition: service_healthy } }`.
 *   2. `addEnvSource(…)` for `bootstrap_servers`, `host`, `port`, `driver`:
 *        - `bootstrap_servers` — `host:port[,host:port…]` list; the
 *          load-bearing demonstration that EnvSource values are opaque.
 *          Tagged `protocol: 'kafka'`.
 *        - `host` / `port`     — split form, useful for clients that take
 *          separate fields.
 *        - `driver`            — literal `'kafka'`; matches the convention
 *          established by `plugin-redis`/`plugin-postgres` for routing
 *          adapters.
 *
 * Wire it into a project:
 *
 * ```ts
 * import kafka from '@levelzero/plugin-kafka';
 *
 * export default {
 *   plugins: [kafka()],
 * };
 * ```
 */
export default function kafka(opts: KafkaOptions = {}): Plugin<
  'kafka',
  {
    named: 'bootstrap_servers' | 'host' | 'port' | 'driver';
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-kafka',
    namespace: (opts.namespace ?? 'kafka') as 'kafka',
    version: '0.1.0',

    register(api: PluginAPI<'kafka'>, _ctx: PluginContext): void {
      // 1. Compose service — single-node KRaft. The KRaft fields below are
      //    the minimum viable set for a self-contained broker+controller in
      //    one process: `KAFKA_PROCESS_ROLES` opts into KRaft, the quorum
      //    voters list points at itself, two listeners split internal
      //    (PLAINTEXT) and controller traffic, and `CLUSTER_ID` is a
      //    stable identifier so restarts don't re-init storage.
      const service: ComposeServiceDef = {
        image: opts.image ?? 'confluentinc/cp-kafka:7.6.0',
        environment: {
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
          KAFKA_LISTENERS:
            'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
          KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
          KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
            'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
          CLUSTER_ID: 'levelzero-kafka-dev',
        },
        ports: ['${PORT_kafka}:9092'],
        healthcheck: {
          test: [
            'CMD-SHELL',
            'kafka-broker-api-versions --bootstrap-server localhost:9092 || exit 1',
          ],
          interval: '10s',
          retries: 12,
          start_period: '20s',
        },
      };
      api.addComposeService('kafka', service);

      // 2. EnvSources — published under the `kafka` namespace. The framework
      //    composes `kafka.<name>` from the namespace; at this API surface
      //    we only register the short local names.
      api.addEnvSource('host', {
        host: () => 'localhost',
        container: () => 'kafka',
      });

      api.addEnvSource('port', {
        host: ({ ports }) => String(ports.kafka ?? ''),
        container: () => '9092',
      });

      api.addEnvSource('driver', {
        host: () => 'kafka',
        container: () => 'kafka',
      });

      // bootstrap_servers — the load-bearing demonstration of the design's
      // protocol opacity. NOT a URL; clients consume this as a list of
      // `host:port` pairs. Tagged `protocol: 'kafka'` so future tooling can
      // dispatch on it without coupling to URL shapes.
      api.addEnvSource('bootstrap_servers', {
        host: ({ ports }) => `localhost:${ports.kafka ?? ''}`,
        container: () => 'kafka:9092',
        protocol: 'kafka',
      });
    },
  };
}
