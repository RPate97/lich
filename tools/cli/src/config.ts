import type { AdapterSlot } from './adapters/registry';

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
  return cfg;
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
