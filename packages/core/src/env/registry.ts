import type { BulkEnvSource, EnvSource } from './types';

/**
 * One named EnvSource registration. `fullKey` is the composed
 * `${namespace}.${name}` identifier — the same string consumers reference from
 * `envInjection`. Stored alongside the parts so the resolver can attribute
 * lookup failures without re-parsing the key.
 */
export interface NamedSourceEntry {
  namespace: string;
  name: string;
  /** `${namespace}.${name}` — denormalized for fast lookup + error messages. */
  fullKey: string;
  source: EnvSource;
  /** The plugin that contributed this source. Used in collision messages. */
  pluginName: string;
}

/**
 * One bulk EnvSource registration. At most one bulk source per namespace; a
 * second registration with the same namespace is a hard error.
 */
export interface BulkSourceEntry {
  namespace: string;
  source: BulkEnvSource;
  /** The plugin that contributed this source. Used in collision messages. */
  pluginName: string;
}

/**
 * Collects named + bulk EnvSource registrations from every plugin during boot.
 * The boot wiring (`bootPlugins`) wraps each plugin's `PluginAPI` so calls to
 * `addEnvSource(name, …)` end up here under the fully-qualified key
 * `${plugin.namespace}.${name}`.
 *
 * Two collisions are hard errors:
 *
 *  - Two plugins claim the same `(namespace, name)` named source.
 *  - Two plugins claim the same bulk namespace.
 *
 * Both error messages name the offending plugin and the prior registrant so
 * consumers can attribute the conflict. Plan 16's `envInjection` collision
 * rules (importAll last-wins, explicit overrides) apply at the resolver, not
 * here — this layer treats every contribution as authoritative.
 */
export class EnvSourceRegistry {
  private readonly named = new Map<string, NamedSourceEntry>();
  private readonly bulk = new Map<string, BulkSourceEntry>();

  /**
   * Register a named source. Throws on `(namespace, name)` collision with a
   * message naming both the new and prior plugin.
   */
  registerNamed(entry: NamedSourceEntry): void {
    const existing = this.named.get(entry.fullKey);
    if (existing) {
      throw new Error(
        `EnvSource collision on "${entry.fullKey}": plugin "${entry.pluginName}" tried to register it, but plugin "${existing.pluginName}" already did`,
      );
    }
    this.named.set(entry.fullKey, entry);
  }

  /**
   * Register a bulk source under a namespace. Throws on namespace collision
   * with a message naming both the new and prior plugin.
   */
  registerBulk(entry: BulkSourceEntry): void {
    const existing = this.bulk.get(entry.namespace);
    if (existing) {
      throw new Error(
        `EnvSource bulk collision on namespace "${entry.namespace}": plugin "${entry.pluginName}" tried to register a bulk source, but plugin "${existing.pluginName}" already did`,
      );
    }
    this.bulk.set(entry.namespace, entry);
  }

  /** Look up a single named source by `${namespace}.${name}`. */
  getNamed(fullKey: string): NamedSourceEntry | undefined {
    return this.named.get(fullKey);
  }

  /** Look up the bulk source registered for a namespace. */
  getBulk(namespace: string): BulkSourceEntry | undefined {
    return this.bulk.get(namespace);
  }

  /** Snapshot of every named source — used by `env list` and the resolver. */
  listNamed(): NamedSourceEntry[] {
    return [...this.named.values()];
  }

  /** Snapshot of every bulk source — used by `env list` and the resolver. */
  listBulk(): BulkSourceEntry[] {
    return [...this.bulk.values()];
  }
}
