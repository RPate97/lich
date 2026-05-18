import type { AdapterSlot } from './adapters/registry';
import type { Plugin, PluginFactory } from './plugins/types';

/**
 * Entry in the `plugins` array of `levelzero.config.ts`. May be:
 *  - a fully-constructed `Plugin` object (`import postgres from '...' ; { plugins: [postgres] }`)
 *  - a string specifier (npm package name or relative path) the loader will
 *    dynamic-import at boot
 *  - a thenable (typically `import('@levelzero/plugin-x')`) resolving to a
 *    `Plugin` or a CJS-style `{ default: Plugin }` module namespace
 *  - a zero-argument factory (sync or async) returning a `Plugin` — the shape
 *    Plan 16 / LEV-179 standardizes on so plugins can take options at
 *    construction time (`plugins: [postgres({ port: 5433 })]`)
 *
 * The parser only validates the *shape* of each entry — it does not resolve
 * Promises, invoke factories, or import strings. That work happens later in
 * the plugin loader.
 */
export type PluginEntry =
  | Plugin
  | string
  | Promise<Plugin | { default: Plugin }>
  | PluginFactory;

/**
 * Set of valid adapter slot names. Kept here (rather than imported as a value
 * from the registry) so the config parser stays independent of the registry's
 * runtime — only the `AdapterSlot` type crosses the boundary. If a new slot is
 * added to `AdapterSlot`, TypeScript's `satisfies` check below forces this set
 * to be updated in lockstep.
 */
const VALID_ADAPTER_SLOTS = new Set<AdapterSlot>([
  'orm',
  'auth',
  'ui',
  'browser',
  'backend',
  'frontend',
  'test-runner',
  'portless',
] satisfies AdapterSlot[]);

/**
 * Adapter selections from `levelzero.config.ts`. Per-slot values name a
 * built-in adapter (e.g. `orm: 'prisma'`) registered in `AdapterRegistry`;
 * the boot path will call `setActive(slot, name)` for each entry.
 *
 * `custom` maps a free-form key to a project-local plugin path that the
 * loader can dynamic-import and register. The key is *not* an `AdapterSlot` —
 * custom plugins choose their own slot at registration time.
 */
export interface AdaptersConfig {
  orm?: string;
  auth?: string;
  ui?: string;
  browser?: string;
  backend?: string;
  frontend?: string;
  'test-runner'?: string;
  portless?: string;
  custom?: Record<string, string>;
}

export interface LevelzeroConfig {
  name?: string;
  /**
   * Optional adapter selections. Absent block = use built-in defaults from
   * `getBuiltinAdapters()`. See `AdaptersConfig` for the shape.
   */
  adapters?: AdaptersConfig;
  /**
   * Optional plugin list. Each entry is a `Plugin` object, a string specifier
   * (package name or relative path) the loader will dynamic-import, or a
   * Promise resolving to a Plugin (e.g. `import('@levelzero/plugin-postgres')`).
   * See `PluginEntry` for the full shape.
   */
  plugins?: PluginEntry[];
  /**
   * Optional env-injection map (Plan 16). Keys are environment variable names
   * to inject into services; values are either:
   *   - a fully-qualified named source reference (`"namespace.name"`)
   *   - an array of bulk-source namespaces (`importAll: ['infisical']`)
   *
   * Authored via `defineConfig()` for type inference (see `./define-config.ts`).
   * This base shape is intentionally loose — the runtime parser just confirms
   * the field is an object. Source-key resolution + validation lands in Plan 16
   * Tier 2 (LEV-181/182); for now the loader carries the field through verbatim.
   */
  envInjection?: Record<string, string | string[]>;
  // Other adapter slots and services land in later plans. Keep this surface
  // minimal in plan 01 — every later plan extends it via module declaration
  // merging or interface extension.
}

export async function loadConfig(configPath: string): Promise<LevelzeroConfig> {
  // Dynamic import works under Bun for .ts files natively. Use a cache-busting
  // query so successive loads in a single process pick up edits during tests.
  const url = `file://${configPath}?t=${Date.now()}`;
  const mod = (await import(url)) as { default?: LevelzeroConfig };
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(
      `levelzero config at ${configPath} has no default export (expected: \`export default { ... }\`)`,
    );
  }
  const cfg = mod.default;
  if (cfg.adapters !== undefined) {
    validateAdapters(cfg.adapters, configPath);
  }
  if (cfg.plugins !== undefined) {
    validatePlugins(cfg.plugins, configPath);
  }
  if (cfg.envInjection !== undefined) {
    validateEnvInjection(cfg.envInjection, configPath);
  }
  return cfg;
}

/**
 * Loose shape check for `envInjection`. LEV-180 only enforces "is an object";
 * resolving the entries to real EnvSources + reporting missing references is
 * Plan 16 Tier 2's job (LEV-181/182), where the EnvSourceRegistry is queried
 * after plugin boot.
 */
function validateEnvInjection(
  envInjection: unknown,
  configPath: string,
): asserts envInjection is Record<string, string | string[]> {
  if (typeof envInjection !== 'object' || envInjection === null || Array.isArray(envInjection)) {
    throw new Error(
      `levelzero config at ${configPath}: \`envInjection\` must be an object (got ${describe(envInjection)})`,
    );
  }
}

function validatePlugins(plugins: unknown, configPath: string): asserts plugins is PluginEntry[] {
  if (!Array.isArray(plugins)) {
    throw new Error(
      `levelzero config at ${configPath}: \`plugins\` must be an array (got ${describe(plugins)})`,
    );
  }
  for (let i = 0; i < plugins.length; i++) {
    const entry: unknown = plugins[i];
    if (typeof entry === 'string') continue;
    if (typeof entry === 'function') continue; // PluginFactory — invoked at boot
    if (isThenable(entry)) continue;
    if (isPluginObject(entry)) continue;
    throw new Error(
      `levelzero config at ${configPath}: \`plugins[${i}]\` must be a string specifier, a Plugin object ({ name, version, register }), a factory function returning a Plugin, or a Promise resolving to one (got ${describe(entry)})`,
    );
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isPluginObject(value: unknown): value is Plugin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { name?: unknown; version?: unknown; register?: unknown };
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.register === 'function'
  );
}

function validateAdapters(adapters: unknown, configPath: string): asserts adapters is AdaptersConfig {
  if (typeof adapters !== 'object' || adapters === null || Array.isArray(adapters)) {
    throw new Error(
      `levelzero config at ${configPath}: \`adapters\` must be an object (got ${describe(adapters)})`,
    );
  }
  for (const [key, value] of Object.entries(adapters as Record<string, unknown>)) {
    if (key === 'custom') {
      validateCustom(value, configPath);
      continue;
    }
    if (!VALID_ADAPTER_SLOTS.has(key as AdapterSlot)) {
      const valid = Array.from(VALID_ADAPTER_SLOTS).join(', ');
      throw new Error(
        `levelzero config at ${configPath}: unknown adapter slot "${key}" (valid slots: ${valid}, or "custom")`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `levelzero config at ${configPath}: \`adapters.${key}\` must be a string adapter name (got ${describe(value)})`,
      );
    }
  }
}

function validateCustom(custom: unknown, configPath: string): void {
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new Error(
      `levelzero config at ${configPath}: \`adapters.custom\` must be an object of { name: pluginPath } (got ${describe(custom)})`,
    );
  }
  for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(
        `levelzero config at ${configPath}: \`adapters.custom.${key}\` must be a string plugin path (got ${describe(value)})`,
      );
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
