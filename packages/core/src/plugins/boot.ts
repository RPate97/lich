import { AdapterRegistry, type AdapterSlot } from '../adapters/registry';
import { CommandRegistry } from '../commands/registry';
import { RuleRegistry } from '../check/registry';
import type { Command } from '../commands/types';
import type { Rule } from '../check/types';
import type { OwnedService } from '../services/types';
import type { LevelzeroConfig, PluginEntry } from '../config';
import { EnvSourceRegistry } from '../env/registry';
import type { BulkEnvSource, EnvSource } from '../env/types';
import { loadPlugin } from './loader';
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
}

/**
 * Boot the plugin runtime: resolve every entry in `config.plugins`, construct
 * a fresh `PluginAPI` backed by empty registries, then call each plugin's
 * `register(api, ctx)` in declared order.
 *
 * Resolution rules per `PluginEntry`:
 *
 *   - **string** — handed to {@link loadPlugin} (npm specifier or relative
 *     path resolved against `projectRoot`).
 *   - **Plugin object** — used as-is.
 *   - **Promise** — awaited; if the result is a CJS-style module namespace
 *     (`{ default: Plugin }`), the `default` is unwrapped.
 *
 * `register()` is invoked sequentially. Plugin order is meaningful for
 * `setActiveAdapter` (later calls win) and for any other mutations a plugin
 * makes against an already-populated registry.
 *
 * Any failure during register() is rewrapped with the offending plugin's
 * `name` embedded so the caller can attribute it. Failures during plugin
 * resolution itself surface from {@link loadPlugin} unchanged (its messages
 * already carry the specifier).
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

  const ctx: PluginContext = { projectRoot, config };

  // Per-plugin facade. We re-create the API for every plugin so the closure
  // captures the *plugin name + namespace* used in error attribution and in
  // composing fully-qualified EnvSource keys (`${namespace}.${name}`). The
  // namespace fallback (`plugin.namespace ?? plugin.name`) is the LEV-178
  // baseline; LEV-179 will improve it to strip `@scope/plugin-` prefixes.
  const makeApi = (plugin: Plugin): PluginAPI => {
    const namespace = plugin.namespace ?? plugin.name;
    return {
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
      },
      addBulkEnvSource(source: BulkEnvSource): void {
        envSources.registerBulk({
          namespace,
          source,
          pluginName: plugin.name,
        });
      },
    };
  };

  const entries = config.plugins ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as PluginEntry;
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
  }

  return {
    commands,
    adapters,
    generators,
    rules,
    ownedServices,
    compose,
    skillsDirs,
    envSources,
  };
}

/**
 * Normalize a single `PluginEntry` to a `Plugin`. The three accepted shapes
 * mirror what `LevelzeroConfig['plugins']` accepts:
 *
 *   - string — passed through {@link loadPlugin}.
 *   - Plugin — returned as-is.
 *   - Promise — awaited; if the resolved value is `{ default: Plugin }`, the
 *     default is unwrapped.
 *
 * Anything else is a programming error in the consumer's config; we throw
 * with the entry's index so the failure is locatable.
 */
async function resolvePluginEntry(
  entry: PluginEntry,
  ctx: PluginContext,
  index: number,
): Promise<Plugin> {
  if (typeof entry === 'string') {
    return loadPlugin(entry, ctx);
  }
  if (isThenable(entry)) {
    const resolved = await entry;
    if (isPlugin(resolved)) return resolved;
    if (
      typeof resolved === 'object' &&
      resolved !== null &&
      isPlugin((resolved as { default?: unknown }).default)
    ) {
      return (resolved as { default: Plugin }).default;
    }
    throw new Error(
      `plugins[${index}]: Promise resolved to a value that is not a Plugin or { default: Plugin }`,
    );
  }
  if (isPlugin(entry)) {
    return entry;
  }
  throw new Error(
    `plugins[${index}]: entry is not a string, Plugin, or Promise (got ${typeof entry})`,
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.version === 'string' &&
    typeof v.register === 'function'
  );
}
