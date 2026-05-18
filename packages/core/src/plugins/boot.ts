import { AdapterRegistry, type AdapterSlot } from '../adapters/registry';
import { CommandRegistry } from '../commands/registry';
import { RuleRegistry } from '../check/registry';
import type { Command } from '../commands/types';
import type { Rule } from '../check/types';
import type { OwnedService } from '../services/types';
import type { LevelzeroConfig, PluginEntry } from '../config';
import { promoteEnvContributions } from '../env/compat';
import { EnvSourceRegistry } from '../env/registry';
import { NamespaceCollisionError } from '../env/errors';
import { validateEnvInjection } from '../env/resolve';
import type { BulkEnvSource, EnvSource } from '../env/types';
import { resolvePluginEntry } from './loader';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  Generator,
  Plugin,
  PluginAPI,
  PluginContext,
} from './types';

/**
 * Minimal registry for plugin-contributed generators. LEV-124 will replace
 * this with a richer module under `src/gen/`; for now boot just collects them
 * so the dispatcher has a single place to look. The shape is intentionally
 * symmetric with the other registries the dispatcher consumes
 * (`register` + `list` + `lookup`).
 *
 * Re-registering the same id replaces the previous entry, matching
 * `CommandRegistry` and `AdapterRegistry` semantics.
 */
export class GeneratorRegistry {
  private readonly map = new Map<string, Generator>();

  register(gen: Generator): void {
    this.map.set(gen.id, gen);
  }

  lookup(id: string): Generator | undefined {
    return this.map.get(id);
  }

  all(): Generator[] {
    return [...this.map.values()];
  }
}

/**
 * Compose contributions accumulated across plugins. The dispatcher (or the
 * compose-file emitter from LEV-131) consumes this verbatim. Last-write-wins
 * per top-level name (services / volumes / networks), mirroring how
 * `PluginAPI.addComposeService` is defined: re-registering with the same name
 * overrides the previous contribution.
 */
export interface ComposeContributions {
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
}

/**
 * The assembled runtime state produced by `bootPlugins`. The CLI dispatcher
 * holds one `BootResult` per invocation and routes work through it. Every
 * field is owned by this object — callers should treat them as live state for
 * the duration of the run and not mutate them concurrently from elsewhere.
 */
export interface BootResult {
  commands: CommandRegistry;
  adapters: AdapterRegistry;
  generators: GeneratorRegistry;
  rules: RuleRegistry;
  ownedServices: OwnedService[];
  compose: ComposeContributions;
  skillsDirs: string[];
  /**
   * Named + bulk EnvSource registrations collected from every plugin.
   * Plan 16 Tier 2 (LEV-181/182) consumes this to resolve and inject env
   * variables into services. Tier 1 only collects.
   */
  envSources: EnvSourceRegistry;
  /**
   * Shared cache of resolved bulk sources keyed by namespace. Populated
   * lazily by {@link resolveEnvForService} so multiple services in a single
   * CLI invocation share work — each registered bulk source's `resolve()`
   * runs at most once per boot. Empty at the point `bootPlugins` returns;
   * the dispatcher threads this through to every per-service resolution.
   */
  resolvedBulkSources: Map<string, Record<string, string>>;
  /**
   * The set of plugins that successfully booted, in declaration order. Each
   * entry is taken straight from the `Plugin` returned by
   * `resolvePluginEntry` — `name` and `version` are guaranteed by the
   * `isPlugin` guard. The CLI's `--help` renderer surfaces this list under
   * "LOADED PLUGINS"; other consumers can use it to attribute behavior or
   * print diagnostic banners. Plugins that throw during `register()` short-
   * circuit the boot before reaching this list, so it's safe to treat each
   * entry as fully initialized.
   */
  loadedPlugins: Array<{ name: string; version: string }>;
}

/**
 * Boot the plugin runtime: resolve every entry in `config.plugins`, construct
 * a fresh `PluginAPI` backed by empty registries, then call each plugin's
 * `register(api, ctx)` in declared order.
 *
 * Each `PluginEntry` (string specifier, factory function, Promise, or
 * pre-built `Plugin` object) is normalized by `resolvePluginEntry` in
 * `./loader` — see its docs for the full dispatch table. That helper also
 * fills in `plugin.namespace` from the package name when the plugin didn't
 * set one explicitly.
 *
 * `register()` is invoked sequentially. Plugin order is meaningful for
 * `setActiveAdapter` (later calls win) and for any other mutations a plugin
 * makes against an already-populated registry.
 *
 * Any failure during register() is rewrapped with the offending plugin's
 * `name` embedded so the caller can attribute it. Failures during plugin
 * resolution itself surface from `resolvePluginEntry` unchanged (its messages
 * already carry the entry's index).
 */
export async function bootPlugins(
  config: LevelzeroConfig,
  projectRoot: string,
): Promise<BootResult> {
  const commands = new CommandRegistry();
  const adapters = new AdapterRegistry();
  const generators = new GeneratorRegistry();
  const rules = new RuleRegistry();
  const ownedServices: OwnedService[] = [];
  const compose: ComposeContributions = { services: {}, volumes: {}, networks: {} };
  const skillsDirs: string[] = [];
  const envSources = new EnvSourceRegistry();
  const resolvedBulkSources = new Map<string, Record<string, string>>();
  const loadedPlugins: Array<{ name: string; version: string }> = [];

  // `envSources` is the shared, mutable registry that every plugin's
  // `register()` writes into via `api.addEnvSource(...)`. Exposing a getter on
  // `PluginContext` lets a plugin's command factories close over the registry
  // so they read its FULLY POPULATED state at command-run time (not at
  // register-time, when only earlier plugins' sources are present). The
  // closure captures `envSources` by reference, so identity is stable for the
  // duration of the boot and the same registry instance is returned to every
  // caller.
  const ctx: PluginContext = {
    projectRoot,
    config,
    getEnvSourceRegistry: () => envSources,
  };

  // Plugin-name list per namespace, populated as plugins register. The
  // registry already catches per-`(namespace, name)` and per-bulk-namespace
  // collisions at registration time; this map drives the higher-level
  // "two different plugins claim the same namespace" check that runs after
  // every plugin has registered. Same-plugin re-registration is fine —
  // de-duplicated via a Set.
  const namespacePlugins = new Map<string, Set<string>>();

  // Per-plugin facade. We re-create the API for every plugin so the closure
  // captures the *plugin name + namespace* used in error attribution and in
  // composing fully-qualified EnvSource keys (`${namespace}.${name}`). The
  // namespace is guaranteed populated by `resolvePluginEntry` (LEV-179):
  // explicit `plugin.namespace` always wins, otherwise the loader derives one
  // by stripping the `@scope/plugin-` prefix from `plugin.name`.
  const makeApi = (plugin: Plugin): PluginAPI => {
    const namespace = plugin.namespace ?? plugin.name;
    const api: PluginAPI = {
      addAdapter(slot: AdapterSlot, name: string, impl: unknown): void {
        adapters.register({ slot, name, impl });
      },
      setActiveAdapter(slot: AdapterSlot, name: string): void {
        adapters.setActive(slot, name);
      },
      addCommand(cmd: Command): void {
        commands.register(cmd);
      },
      addOwnedService(service: OwnedService): void {
        ownedServices.push(service);
        // LEV-185 backwards-compat shim: legacy plugins still ship an
        // `envContributions(ports) => Record<string, string>` function on
        // their `OwnedService`. Promote those keys to named EnvSources under
        // the plugin's namespace so the new resolver picks them up. Plugins
        // migrated to explicit `api.addEnvSource()` calls (LEV-187) keep
        // working — duplicate registrations are silently skipped inside the
        // shim. Once every v0 plugin is migrated, the shim sees no
        // `envContributions` functions and stays silent; Plan 17 removes it.
        promoteEnvContributions(service, api, plugin.name);
      },
      addComposeService(name: string, def: ComposeServiceDef): void {
        compose.services[name] = def;
      },
      addComposeVolume(name: string, def: ComposeVolumeDef): void {
        compose.volumes[name] = def;
      },
      addComposeNetwork(name: string, def: ComposeNetworkDef): void {
        compose.networks[name] = def;
      },
      addRule(rule: Rule): void {
        rules.register(rule);
      },
      addGenerator(gen: Generator): void {
        generators.register(gen);
      },
      addSkillsDir(absPath: string): void {
        skillsDirs.push(absPath);
      },
      addEnvSource(name: string, source: EnvSource): void {
        envSources.registerNamed({
          namespace,
          name,
          fullKey: `${namespace}.${name}`,
          source,
          pluginName: plugin.name,
        });
        recordNamespaceClaim(namespacePlugins, namespace, plugin.name);
      },
      addBulkEnvSource(source: BulkEnvSource): void {
        envSources.registerBulk({
          namespace,
          source,
          pluginName: plugin.name,
        });
        recordNamespaceClaim(namespacePlugins, namespace, plugin.name);
      },
    };
    return api;
  };

  const entries = config.plugins ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as PluginEntry;
    // `resolvePluginEntry` lives in `./loader` (LEV-179): it handles every
    // `PluginEntry` variant — string specifier, factory function, Promise,
    // or pre-built Plugin — and auto-derives a namespace from the package
    // name when the plugin didn't set one. Boot stays agnostic to which
    // shape the consumer used.
    const plugin = await resolvePluginEntry(entry, ctx, i);
    const api = makeApi(plugin);
    try {
      await plugin.register(api, ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`plugin "${plugin.name}" failed during register(): ${reason}`, {
        cause: err,
      });
    }
    // Track successful boots only — a plugin that threw during register()
    // already short-circuited above, so the loaded list never includes it.
    loadedPlugins.push({ name: plugin.name, version: plugin.version });
  }

  // Cross-plugin validation (Plan 16 / LEV-181). The per-plugin registry
  // already caught duplicate `(namespace, name)` and duplicate bulk-namespace
  // collisions at registration time. Two checks remain that need a full
  // view of every loaded plugin:
  //
  //  1. Namespace collision — two *different* plugins claim the same
  //     namespace (e.g. both pass `namespace: 'postgres'`). This can sneak
  //     past the registry when the plugins contribute disjoint name sets
  //     (one adds `postgres.url`, the other adds `postgres.host`).
  //
  //  2. `envInjection` reference validation — every explicit entry must
  //     resolve to a registered named source or a registered bulk
  //     namespace, and every `importAll` entry must reference a registered
  //     bulk namespace. Runtime keys inside a bulk namespace can only be
  //     checked after `resolve()` runs, so {@link resolveEnvForService}
  //     repeats this validation at injection time.
  for (const [namespace, plugins] of namespacePlugins) {
    if (plugins.size > 1) {
      throw new NamespaceCollisionError(namespace, [...plugins]);
    }
  }
  validateEnvInjection(envSources, config.envInjection);

  return {
    commands,
    adapters,
    generators,
    rules,
    ownedServices,
    compose,
    skillsDirs,
    envSources,
    resolvedBulkSources,
    loadedPlugins,
  };
}

/**
 * Append `pluginName` to the set of plugins claiming `namespace`. Used by
 * the EnvSource wiring inside `bootPlugins` to detect cross-plugin namespace
 * collisions (two distinct plugins each declaring `namespace: 'postgres'`).
 * The same plugin registering multiple sources under its own namespace is
 * fine — Set de-duplication makes that a no-op.
 */
function recordNamespaceClaim(
  map: Map<string, Set<string>>,
  namespace: string,
  pluginName: string,
): void {
  let plugins = map.get(namespace);
  if (!plugins) {
    plugins = new Set();
    map.set(namespace, plugins);
  }
  plugins.add(pluginName);
}

