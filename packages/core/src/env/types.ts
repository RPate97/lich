/**
 * Foundational types for the EnvSource system (Plan 16 / LEV-178).
 *
 * An `EnvSource` is the contract by which plugins publish values that the
 * runtime injects as environment variables into services — both compose-managed
 * containers and host-spawned owned services. The system supports two shapes:
 *
 *  - **Named sources** (`EnvSource`) publish a single named value addressable
 *    as `${namespace}.${name}` (e.g. `postgres.url`). The plugin author calls
 *    `api.addEnvSource('url', source)` and the framework composes the
 *    fully-qualified key using the plugin's declared namespace.
 *  - **Bulk sources** (`BulkEnvSource`) publish a `Record<string, string>` of
 *    values produced at resolution time. Used for dotenv/Infisical/Vault-style
 *    secret loaders whose keys are determined by the upstream store, not the
 *    plugin. A plugin contributes at most one bulk source per namespace.
 *
 * The resolution-time behavior (host vs container context, value caching,
 * collision handling) lives in later Plan 16 tickets; this module is the
 * types-only contract everyone else builds on.
 */

/**
 * Protocol identifier for a named EnvSource. Used by future tooling to drive
 * protocol-aware behavior (compose DNS wiring, healthcheck synthesis, etc.)
 * without coupling to any specific implementation.
 *
 * Intentionally open-ended via `(string & {})` so plugins can publish novel
 * protocols (Kafka bootstrap lists, MQTT brokers, …) without core releases.
 * The named alternates exist to provide autocomplete for the common cases.
 */
export type Protocol =
  | 'http'
  | 'https'
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'kafka'
  | 'amqp'
  | 'mqtt'
  | 'grpc'
  | 'graphql'
  | 's3'
  | (string & {});

/**
 * Read-only context handed to every EnvSource resolver. Same data is passed
 * to both `host` and `container` resolvers on named sources and to `resolve`
 * on bulk sources.
 *
 *  - `ports`           — fully resolved port map (`portName -> hostPort`)
 *                        from the stack-allocator. Available to every
 *                        resolver; ports never change between host and
 *                        container resolution.
 *  - `projectRoot`     — absolute path to the consumer's project root. Used
 *                        by secret-source plugins so a `.env.local` in the
 *                        main workspace is read by every worktree.
 *  - `worktreeKey`     — stable short identifier of the active worktree.
 *                        Plugins that need worktree-scoped state (caches,
 *                        runtime tokens) scope under
 *                        `.lich/state/<worktreeKey>/`.
 *  - `consumerContext` — whether the value is being injected into a host
 *                        process (`'host'`) or a container's environment
 *                        block (`'container'`). Named sources use this
 *                        implicitly via the two resolver functions; bulk
 *                        sources receive it directly and may branch on it.
 */
export interface EnvSourceContext {
  ports: Record<string, number>;
  projectRoot: string;
  worktreeKey: string;
  consumerContext: 'host' | 'container';
}

/**
 * A named EnvSource publishes a single value under a name. The framework
 * picks `host` vs `container` based on the consumer service kind — host-spawned
 * owned services get `host()`, compose-managed services get `container()`.
 *
 * Both resolvers receive the same `EnvSourceContext` and may be sync or async.
 * `protocol` is optional metadata; future tooling may dispatch on it.
 */
export interface EnvSource {
  host: (ctx: EnvSourceContext) => string | Promise<string>;
  container: (ctx: EnvSourceContext) => string | Promise<string>;
  protocol?: Protocol;
}

/**
 * A bulk EnvSource resolves to a `Record<string, string>` whose keys ARE the
 * env var names. Used for "load whatever you find" sources (dotenv, Infisical,
 * AWS Secrets Manager) where the available keys aren't known until resolution.
 *
 * Bulk sources have no host/container distinction by default — a secret is the
 * same value either way. A bulk source that needs context-aware values can
 * branch on `ctx.consumerContext` inside its `resolve()`.
 */
export interface BulkEnvSource {
  resolve: (ctx: EnvSourceContext) => Promise<Record<string, string>> | Record<string, string>;
}

/**
 * Type-only manifest describing what env sources a plugin exposes. Carried as
 * the second type parameter of `Plugin<NS, S>` so `defineConfig()` (LEV-180)
 * can infer the legal `envInjection` reference strings from the plugin tuple.
 *
 *  - `named` — union of name strings the plugin registers via
 *              `addEnvSource(name, …)`. Composed with the plugin namespace to
 *              produce the qualified key (`${NS}.${named}`).
 *  - `bulk`  — `true` when the plugin registers a bulk source under its
 *              namespace; `false`/absent otherwise.
 *
 * Never read at runtime — purely a vehicle for type inference.
 */
export interface SourceManifest {
  named?: string;
  bulk?: boolean;
}
