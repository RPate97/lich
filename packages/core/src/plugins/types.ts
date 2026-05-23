import type { AdapterSlot } from '../adapters/registry';
import type { ORMAdapter } from '../adapters/orm/types';
import type { Command } from '../commands/types';
import type { OwnedService } from '../services/types';
import type { Rule } from '../check/types';
import type { EnvSourceRegistry } from '../env/registry';
import type { BulkEnvSource, EnvSource, SourceManifest } from '../env/types';
import type { Generator } from '../gen/types';

// LEV-124: re-exported so existing imports (`PluginAPI`, etc.) continue
// pointing at this module without forcing every consumer to update their path.
// The canonical definition now lives in `src/gen/types.ts` alongside the
// `GeneratorContext` / `GeneratorResult` shapes the dispatcher uses.
export type { Generator };

/**
 * Subset of a Docker Compose v2 service definition that plugins can contribute
 * via `PluginAPI.addComposeService`. Fields mirror the upstream compose schema
 * (snake_case, string-valued durations, etc.) so the merged service map can be
 * serialized straight into a compose file without further translation.
 *
 * Port strings use the `"${PORT}:5432"` form — the host side is a variable so
 * the runner can substitute a stack-allocated port, while the container side
 * is fixed by the image.
 *
 * Intentionally open: additional compose-v2 fields can be added as needed as
 * later waves grow what plugins contribute (e.g. `command`, `user`, `tmpfs`).
 */
export interface ComposeServiceDef {
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  /**
   * Pin the container name (compose-v2 `container_name`). When unset, compose
   * generates `<project>-<service>-<idx>`. Used by `dev`/`stop`/`reset` to
   * preserve the legacy `lich-<key>-<service>` naming so registry entries
   * keep working unchanged.
   */
  container_name?: string;
  /** e.g. `["${PORT}:5432"]` — host side typically a variable, container side fixed. */
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: Record<string, { condition: 'service_started' | 'service_healthy' }>;
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  // Additional compose-v2 fields can be added as needed.
}

/** Subset of a compose v2 named-volume definition. */
export interface ComposeVolumeDef {
  driver?: string;
  driver_opts?: Record<string, string>;
  /**
   * Pin the on-disk volume name (compose-v2 `name:`). When unset, compose
   * synthesizes `<project>_<key>`. Used by the docker→compose interim
   * adapter to keep legacy `lich-<key>-<service>-data` naming so
   * existing volumes carry over.
   */
  name?: string;
}

/** Subset of a compose v2 named-network definition. */
export interface ComposeNetworkDef {
  driver?: string;
  /** Pin the on-disk network name; see `ComposeVolumeDef.name`. */
  name?: string;
}

/**
 * Surface plugins use to contribute to the running CLI during `register()`.
 *
 * The API is intentionally narrow and additive: every method registers a
 * contribution under a unique key. Mutation of existing contributions is not
 * exposed — plugins should either override by re-registering with the same
 * name (e.g. `addAdapter`) or compose by reading the merged result downstream.
 *
 * `PluginAPI` is generic over the plugin's namespace string literal so future
 * source-manifest typing (`addEnvSource('url', …)`) can be checked against the
 * plugin's declared `Plugin<NS, S>` manifest. The namespace prefix is added
 * by the framework — plugin authors only type the short local name.
 */
export interface PluginAPI<NS extends string = string> {
  addAdapter(slot: AdapterSlot, name: string, impl: unknown): void;
  setActiveAdapter(slot: AdapterSlot, name: string): void;
  addCommand(cmd: Command): void;
  addOwnedService(service: OwnedService): void;
  addComposeService(name: string, def: ComposeServiceDef): void;
  addComposeVolume(name: string, def: ComposeVolumeDef): void;
  addComposeNetwork(name: string, def: ComposeNetworkDef): void;
  addRule(rule: Rule): void;
  addGenerator(gen: Generator): void;
  addSkillsDir(absPath: string): void;
  /**
   * Register a single named EnvSource under the plugin's namespace.
   *
   * The framework composes the fully-qualified key (`${namespace}.${name}`)
   * before storing the registration in the EnvSourceRegistry. Two plugins
   * publishing the same `(namespace, name)` pair is a hard error at boot.
   *
   * Plan 16 Tier 1 ships the type + plumbing; resolution happens in
   * LEV-181/182.
   */
  addEnvSource<Name extends string>(name: Name, source: EnvSource): void;
  /**
   * Register a single bulk EnvSource under the plugin's namespace. Used for
   * dotenv/Infisical-style loaders whose keys aren't known until resolution.
   * At most one bulk source per namespace; a second registration is a hard
   * error at boot.
   */
  addBulkEnvSource(source: BulkEnvSource): void;
}

/**
 * Read-only context handed to every plugin's `register()`. Plugins should
 * treat the fields as immutable for the duration of the call.
 *
 * `config` is `unknown` until the project-level config type lands; plugins
 * that need to read it should narrow/parse it themselves.
 *
 * `getEnvSourceRegistry` is a deferred handle to the shared, mutable
 * `EnvSourceRegistry` that `bootPlugins` is building. The same object is
 * passed to every plugin and gets populated as plugins call `addEnvSource` /
 * `addBulkEnvSource`. Plugins that need to compose with sources contributed
 * by OTHER plugins (e.g. plugin-prisma's `db.*` commands looking up the
 * active `postgres.url` source) capture this closure in their command
 * factories — by the time a command runs the registry is fully populated.
 * Reading it during `register()` itself sees only the entries added by
 * earlier plugins, which is rarely what you want.
 */
export interface PluginContext {
  projectRoot: string;
  /** Typed once `LichConfig` is defined; `unknown` for now. */
  config: unknown;
  /**
   * Returns the boot-scoped EnvSource registry. Stable identity across calls
   * within a single boot — capture once and reuse. Optional so test
   * fixtures and synthetic PluginContext literals that don't care about
   * cross-plugin composition continue to typecheck.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /**
   * Returns the active `ORMAdapter` from the boot-scoped AdapterRegistry, or
   * `undefined` when no ORM plugin is loaded. Parallels
   * `getEnvSourceRegistry` (LEV-171): plugins capture this closure during
   * `register()` and resolve it at command-run time so the dispatch sees
   * whichever ORM was activated by the time the plugin order finished
   * (a later plugin can `setActiveAdapter('orm', ...)` and the lookup
   * picks that up).
   *
   * Optional so synthetic `PluginContext` literals in tests continue to
   * typecheck without wiring the registry.
   *
   * Introduced in LEV-173 so `plugin-better-auth` can compose with the
   * active ORM instead of hardcoding `better-sqlite3`. See
   * `docs/superpowers/plans/2026-05-17-levelzero-14-plugin-architecture.md`
   * "Composability principle" for the why.
   */
  getActiveOrm?: () => ORMAdapter | undefined;
}

/**
 * The plugin contract. A plugin module exports a `Plugin` (or a default export
 * that satisfies one); the loader calls `register(api, ctx)` exactly once
 * during CLI bootstrap.
 *
 * Generic over the namespace string literal `NS` (used to scope `addEnvSource`
 * registrations) and the source manifest `S` (carries the union of named
 * source keys + bulk-source flag through to `defineConfig()` for autocomplete
 * on `envInjection`). Both parameters default to permissive shapes so
 * existing plugins authored against the unparameterized `Plugin` continue to
 * compile without changes.
 *
 *  - `namespace` is optional for backwards compatibility. LEV-179 teaches
 *    the loader to auto-derive a default by stripping the standard
 *    `@scope/plugin-` prefix from `name` (e.g. `@lich/plugin-postgres`
 *    → `'postgres'`). Explicit `namespace` always wins.
 *  - `__sources` is a phantom — never read at runtime, only typechecked so
 *    `defineConfig()` can infer source keys from the plugin tuple.
 *
 * `register()` may be sync or async — the loader awaits the returned value
 * either way.
 */
export interface Plugin<NS extends string = string, S extends SourceManifest = SourceManifest> {
  name: string;
  /**
   * Optional. When omitted the loader auto-derives a default from `name`
   * (strips the standard `@scope/plugin-` prefix); explicit value always wins.
   */
  namespace?: NS;
  version: string;
  /** Phantom carrying the source manifest for `defineConfig()` type inference. */
  __sources?: S;
  register(api: PluginAPI<NS>, ctx: PluginContext): void | Promise<void>;
}

/**
 * A zero-argument factory returning a `Plugin` (or a Promise of one). Plan 16
 * (LEV-179) introduces this shape so plugins can be authored as parameterised
 * factories (`export default function postgres(opts) { return { ... } }`) and
 * still be wired into a config as `plugins: [postgres()]`.
 *
 * The factory may be async — the loader awaits the returned value either way.
 */
export type PluginFactory<
  NS extends string = string,
  S extends SourceManifest = SourceManifest,
> = () => Plugin<NS, S> | Promise<Plugin<NS, S>>;
