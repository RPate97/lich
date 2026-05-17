import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prismaAdapter } from './orm/prisma';
import { betterAuthAdapter } from './auth/better-auth';
import { shadcnAdapter } from './ui/shadcn';
import { playwrightAdapter } from './browser/playwright';
import { typedClientFrontendAdapter } from './frontend/typed-client';

/**
 * Adapter slot identifiers. Each slot represents one pluggable boundary in
 * the Levelzero stack — exactly one impl per slot is "active" at a time, but
 * the registry can carry several alternative impls (e.g. prisma and drizzle
 * both registered under "orm", with prisma active).
 *
 * Adding a slot here is a breaking change for downstream consumers — keep the
 * list curated. The `test-runner` slot is reserved for an impl landing in a
 * subsequent wave; `portless` is now contributed by the extracted
 * `@levelzero/plugin-portless` package, and `backend` (hono) is contributed
 * by `@levelzero/plugin-hono` — both are absent from `getBuiltinAdapters()`
 * (the slot identifiers stay declared here so the type remains stable across
 * the extractions).
 */
export type AdapterSlot =
  | 'orm'
  | 'auth'
  | 'ui'
  | 'browser'
  | 'backend'
  | 'frontend'
  | 'test-runner'
  | 'portless';

/**
 * One adapter entry in the registry. `impl` is intentionally `unknown` so the
 * registry stays decoupled from each slot's specific interface — callers cast
 * to the slot's expected type at the call site (where they know which slot
 * they're pulling from).
 */
export interface AdapterEntry {
  slot: AdapterSlot;
  name: string;
  impl: unknown;
}

/**
 * In-memory registry of adapter impls per slot.
 *
 * Single source of truth: the CLI (codegen, runners, etc.) reads from one
 * `AdapterRegistry` instance built by `getBuiltinAdapters()` (or a custom
 * one in tests). `register()` is idempotent on (slot, name) — re-registering
 * the same pair replaces the impl, so consumers can override built-ins by
 * registering after `getBuiltinAdapters()`.
 *
 * Active state is tracked per slot, separate from registration order. There
 * is no implicit default: `getActive(slot)` throws until someone explicitly
 * calls `setActive(slot, name)`. `getBuiltinAdapters()` does that wiring for
 * the impls it registers; brand-new slots remain inactive until populated.
 */
export class AdapterRegistry {
  private readonly entries = new Map<AdapterSlot, Map<string, AdapterEntry>>();
  private readonly active = new Map<AdapterSlot, string>();

  register(entry: AdapterEntry): void {
    let bucket = this.entries.get(entry.slot);
    if (!bucket) {
      bucket = new Map();
      this.entries.set(entry.slot, bucket);
    }
    bucket.set(entry.name, entry);
  }

  list(): AdapterEntry[] {
    const all: AdapterEntry[] = [];
    for (const bucket of this.entries.values()) {
      for (const e of bucket.values()) all.push(e);
    }
    return all;
  }

  listBySlot(slot: AdapterSlot): AdapterEntry[] {
    const bucket = this.entries.get(slot);
    if (!bucket) return [];
    return Array.from(bucket.values());
  }

  get(slot: AdapterSlot, name: string): unknown {
    const bucket = this.entries.get(slot);
    const entry = bucket?.get(name);
    if (!entry) {
      throw new Error(`no adapter "${name}" registered for slot "${slot}"`);
    }
    return entry.impl;
  }

  getActive(slot: AdapterSlot): unknown {
    const name = this.active.get(slot);
    if (!name) {
      throw new Error(`no active impl for slot "${slot}"`);
    }
    // The (slot, name) pair must still resolve — defensive in case someone
    // unregisters by replacing then deleting (we don't expose delete, but the
    // bucket lookup also covers the "active set then bucket emptied" edge).
    return this.get(slot, name);
  }

  setActive(slot: AdapterSlot, name: string): void {
    const bucket = this.entries.get(slot);
    if (!bucket || !bucket.has(name)) {
      throw new Error(`cannot set active: no adapter "${name}" registered for slot "${slot}"`);
    }
    this.active.set(slot, name);
  }

  /**
   * Dynamic-import a set of project-local adapter modules and register each
   * one under the slot inferred from its shape (or an explicit `slot`
   * annotation on the adapter object).
   *
   * Each entry of `paths` maps the desired adapter `name` to a path relative
   * to `projectRoot`. For each entry the loader:
   *
   *   1. Resolves `path.resolve(projectRoot, relPath)` to an absolute path.
   *   2. Dynamic-imports that path via a `file://` URL (Windows-safe, and
   *      sidesteps the ESM "absolute paths must be URLs" restriction).
   *   3. Picks the adapter from `mod.default ?? mod[name] ?? mod`, so plugins
   *      can use `export default`, a named export matching the registered
   *      name, or the bare module namespace.
   *   4. Determines the slot from an explicit `adapter.slot` field if
   *      present, otherwise sniffs the adapter's method surface.
   *   5. Calls `this.register({ slot, name, impl: adapter })`.
   *
   * Any failure — import error, missing file, null/undefined adapter, or
   * unrecognized shape — re-throws with the absolute filepath embedded in
   * the message so callers (and the CLI loader at config time) can point
   * the user at exactly which plugin file is broken.
   */
  async loadCustomPlugins(opts: {
    projectRoot: string;
    paths: Record<string, string>;
  }): Promise<void> {
    for (const [name, relPath] of Object.entries(opts.paths)) {
      const absPath = path.resolve(opts.projectRoot, relPath);
      let mod: Record<string, unknown>;
      try {
        // pathToFileURL: ESM dynamic import on absolute Windows paths fails
        // without a file:// scheme, so we always go through a URL.
        mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `failed to load custom plugin "${name}" from ${absPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }

      const adapter =
        (mod.default as unknown) ??
        (mod[name] as unknown) ??
        (mod as unknown);

      if (adapter == null || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
        throw new Error(
          `custom plugin "${name}" at ${absPath} did not export a valid adapter (got ${adapter === null ? 'null' : typeof adapter})`,
        );
      }

      let slot: AdapterSlot;
      try {
        slot = detectSlot(adapter as Record<string, unknown>);
      } catch (err) {
        throw new Error(
          `custom plugin "${name}" at ${absPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }

      this.register({ slot, name, impl: adapter });
    }
  }
}

/**
 * Infer which slot a custom adapter belongs in. The order of checks matters:
 *
 *   - An explicit `slot` field on the adapter wins unconditionally (escape
 *     hatch for adapters whose shape collides with another slot, or for
 *     future slots whose shape isn't sniffable yet).
 *   - Otherwise we look at distinctive method combinations. The combinations
 *     are picked to be mutually exclusive among the current slot interfaces
 *     (portless needs register+list+unregister; ui shares `list` but not
 *     `register`+`unregister`; orm/auth/browser/backend/test-runner each have
 *     a unique method that no other slot uses).
 *
 * Throws (without filepath context) if the shape matches nothing — the caller
 * in `loadCustomPlugins` re-throws with the offending plugin's filepath.
 */
function detectSlot(adapter: Record<string, unknown>): AdapterSlot {
  const explicit = adapter.slot;
  if (typeof explicit === 'string' && isAdapterSlot(explicit)) {
    return explicit;
  }

  const has = (key: string): boolean => typeof adapter[key] === 'function';

  // Portless: register/unregister/list — keep first so it wins over ui (which
  // also exposes `list`).
  if (has('register') && has('unregister') && has('list')) return 'portless';
  // Auth: createUser + signSession is unique to AuthAdapter.
  if (has('createUser') && has('signSession')) return 'auth';
  // ORM: applyMigrations + inspectSchema is unique to ORMAdapter.
  if (has('applyMigrations') && has('inspectSchema')) return 'orm';
  // Browser: screenshot + diff is unique to BrowserAdapter.
  if (has('screenshot') && has('diff')) return 'browser';
  // UI: `add` + `list`, but no `register`/`unregister` (caught above).
  if (has('add') && has('list')) return 'ui';
  // Backend: extractRoutes is unique to BackendAdapter.
  if (has('extractRoutes')) return 'backend';
  // Frontend: generateClient at the top level. ORMAdapter also has
  // generateClient, but its other distinctive methods route it to 'orm' first.
  if (has('generateClient')) return 'frontend';
  // Test-runner: bare `run` method.
  if (has('run')) return 'test-runner';

  throw new Error(
    'could not detect adapter slot from shape; add an explicit `slot` field to the adapter',
  );
}

const KNOWN_SLOTS: ReadonlySet<string> = new Set<AdapterSlot>([
  'orm',
  'auth',
  'ui',
  'browser',
  'backend',
  'frontend',
  'test-runner',
  'portless',
]);

function isAdapterSlot(value: string): value is AdapterSlot {
  return KNOWN_SLOTS.has(value);
}

/**
 * Build the default registry: every adapter impl that ships from core, with
 * the sole impl per slot marked active. Slots that are populated by extracted
 * plugins (`portless` — via `@levelzero/plugin-portless`; `backend` — via
 * `@levelzero/plugin-hono`) or that have no concrete impl yet (`test-runner`)
 * are simply absent from the returned registry; `getActive(slot)` throws
 * "no active impl for slot X" until either the plugin is loaded by
 * `bootPlugins` or a later wave lands the impl.
 *
 * Returns a fresh instance each call so tests and CLI invocations don't share
 * mutable state.
 */
export function getBuiltinAdapters(): AdapterRegistry {
  const registry = new AdapterRegistry();

  registry.register({ slot: 'orm', name: 'prisma', impl: prismaAdapter });
  registry.setActive('orm', 'prisma');

  registry.register({ slot: 'auth', name: 'better-auth', impl: betterAuthAdapter });
  registry.setActive('auth', 'better-auth');

  registry.register({ slot: 'ui', name: 'shadcn', impl: shadcnAdapter });
  registry.setActive('ui', 'shadcn');

  registry.register({ slot: 'browser', name: 'playwright', impl: playwrightAdapter });
  registry.setActive('browser', 'playwright');

  registry.register({
    slot: 'frontend',
    name: 'typed-client',
    impl: typedClientFrontendAdapter,
  });
  registry.setActive('frontend', 'typed-client');

  return registry;
}
