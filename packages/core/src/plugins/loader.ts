import { isAbsolute, resolve, basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { PluginEntry } from '../config';
import type { Plugin, PluginContext } from './types';

/**
 * Resolve a single string specifier to a {@link Plugin}. Two forms are
 * supported:
 *
 *  - **Local path** — starts with `.` or `/`. Resolved relative to
 *    {@link PluginContext.projectRoot} (absolute paths are passed through
 *    untouched) and dynamic-imported via a `file://` URL.
 *  - **npm package** — anything else. Dynamic-imported as-is so Node's module
 *    resolution can locate it from the consuming project's `node_modules`.
 *
 * After import the loader picks the plugin object using this precedence:
 *
 *   1. `mod.default`
 *   2. `mod[shorthand]` where `shorthand` is the module basename without
 *      extension (path form) or the bare package name (npm form), camelCased
 *      to match common export conventions
 *   3. `mod` itself
 *
 * The picked value is validated to have `name: string`, `version: string`,
 * and `register: function`. Any failure — import error, missing module, bad
 * shape — is rethrown as an `Error` whose message embeds the original
 * specifier so the caller can surface it to users.
 */
export async function loadPlugin(specifier: string, ctx: PluginContext): Promise<Plugin> {
  const isLocalPath = specifier.startsWith('.') || specifier.startsWith('/');

  let importTarget: string;
  let shorthandSource: string;
  if (isLocalPath) {
    const absPath = isAbsolute(specifier) ? specifier : resolve(ctx.projectRoot, specifier);
    importTarget = pathToFileURL(absPath).href;
    shorthandSource = basename(absPath, extname(absPath));
  } else {
    // Resolve npm specifiers through Node's algorithm rooted at the project,
    // not the CLI's own `node_modules`. The dummy `package.json` path is a
    // standard `createRequire` idiom: only the directory it sits in matters.
    importTarget = resolveNpmSpecifier(specifier, ctx.projectRoot);
    // For scoped packages (`@scope/name`) and subpaths (`pkg/sub`), key the
    // shorthand lookup off the final segment — that's what conventional
    // exports name.
    const tail = specifier.split('/').pop() ?? specifier;
    shorthandSource = tail;
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(importTarget)) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load plugin "${specifier}": ${reason}`);
  }

  const shorthand = toCamelCase(shorthandSource);
  let candidate: unknown =
    (mod as { default?: unknown }).default ??
    (shorthand in mod ? (mod as Record<string, unknown>)[shorthand] : undefined) ??
    mod;

  // LEV-186: plugins may default-export a zero-arg factory (Plan 16 / LEV-179
  // factory shape). When the resolved candidate is a function, invoke it and
  // await the result so the same string-specifier path keeps working after
  // the v0 plugins were converted to factories.
  if (typeof candidate === 'function') {
    try {
      const factoryResult = (candidate as () => unknown)();
      candidate = isThenable(factoryResult) ? await factoryResult : factoryResult;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin "${specifier}" factory threw: ${reason}`, { cause: err });
    }
  }

  if (!isPlugin(candidate)) {
    throw new Error(
      `Plugin "${specifier}" has invalid shape: expected an object with string "name", string "version", and function "register"`,
    );
  }

  return candidate;
}

/**
 * Load every specifier in order via {@link loadPlugin}. The first failure
 * rejects the returned promise; later specifiers are not attempted. Resolution
 * is sequential to keep error reporting deterministic (the first listed
 * failure wins) and to avoid surprising side-effect ordering when plugin
 * modules do top-level work at import time.
 */
export async function loadPlugins(
  specifiers: readonly string[],
  ctx: PluginContext,
): Promise<Plugin[]> {
  const out: Plugin[] = [];
  for (const spec of specifiers) {
    out.push(await loadPlugin(spec, ctx));
  }
  return out;
}

/**
 * Resolve a bare/npm specifier to an absolute `file://` URL using Node's
 * resolution algorithm rooted at `projectRoot`. Falls back to handing the
 * specifier off to dynamic-import directly when local resolution doesn't find
 * it — that way, hosts that pre-load packages (workspaces, monorepos with
 * hoisting, etc.) still work.
 */
function resolveNpmSpecifier(specifier: string, projectRoot: string): string {
  const require = createRequire(join(projectRoot, 'package.json'));
  try {
    const resolved = require.resolve(specifier);
    return pathToFileURL(resolved).href;
  } catch {
    // Let dynamic-import surface its own (more informative) error path.
    return specifier;
  }
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

/**
 * Convert a filename / package-tail like `my-plugin` or `my_plugin` into the
 * camelCase form `myPlugin` so a module that exports `export const myPlugin =
 * {...}` is picked up by the shorthand rule. Leaves already-camelCase names
 * (`namedExport`) unchanged.
 */
function toCamelCase(input: string): string {
  return input.replace(/[-_]([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Normalize a single `PluginEntry` into a `Plugin`. The shapes accepted here
 * are the same union `LevelzeroConfig['plugins']` permits — see `PluginEntry`
 * in `config.ts`. The dispatch order is:
 *
 *  - **string** — handed to {@link loadPlugin} (npm specifier or relative path
 *    resolved against `ctx.projectRoot`).
 *  - **function** — invoked with no arguments (Plan 16 / LEV-179 factory
 *    pattern); the result may be a `Plugin` or a `Promise<Plugin>`.
 *  - **Promise** — awaited; if the resolved value is a CJS-style namespace
 *    (`{ default: Plugin }`), the `default` is unwrapped.
 *  - **Plugin** — returned as-is.
 *
 * After the entry resolves to a `Plugin`, the loader fills in a default
 * `namespace` when none was set (see {@link deriveNamespace}).
 *
 * Failures surface with the entry's array index embedded in the message so
 * config authors can locate the offender. String entries surface their own
 * (specifier-bearing) errors from {@link loadPlugin}.
 */
export async function resolvePluginEntry(
  entry: PluginEntry,
  ctx: PluginContext,
  index: number,
): Promise<Plugin> {
  let resolved: unknown;

  if (typeof entry === 'string') {
    resolved = await loadPlugin(entry, ctx);
  } else if (typeof entry === 'function') {
    let factoryResult: unknown;
    try {
      factoryResult = (entry as () => unknown)();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`plugins[${index}]: factory function threw: ${reason}`, { cause: err });
    }
    resolved = isThenable(factoryResult) ? await factoryResult : factoryResult;
  } else if (isThenable(entry)) {
    resolved = await entry;
  } else {
    resolved = entry;
  }

  // Unwrap a CJS-style `{ default: Plugin }` namespace if we got one.
  if (
    !isPlugin(resolved) &&
    typeof resolved === 'object' &&
    resolved !== null &&
    isPlugin((resolved as { default?: unknown }).default)
  ) {
    resolved = (resolved as { default: Plugin }).default;
  }

  if (!isPlugin(resolved)) {
    throw new Error(
      `plugins[${index}]: entry did not resolve to a valid Plugin (expected an object with string \`name\`, string \`version\`, and function \`register\`)`,
    );
  }

  return ensureNamespace(resolved);
}

/**
 * Derive a short namespace from a plugin package name by stripping the
 * standard `@scope/plugin-` (or bare `plugin-`) prefix. Examples:
 *
 *   `@levelzero/plugin-postgres` → `postgres`
 *   `@my-org/plugin-foo`         → `foo`
 *   `plugin-bar`                 → `bar`
 *   `whatever-else`              → `whatever-else` (no prefix match → identity)
 *
 * Used by the loader to populate `plugin.namespace` when the plugin didn't set
 * one explicitly. Plugin authors who want a different namespace should set
 * `namespace: '...'` on their `Plugin` object — explicit always wins.
 */
export function deriveNamespace(packageName: string): string {
  const match = packageName.match(/(?:^|\/)plugin-([a-z0-9-]+)$/i);
  return match ? match[1]! : packageName;
}

/**
 * Mutating helper: fill in `plugin.namespace` from `plugin.name` when missing,
 * using {@link deriveNamespace}. Returns the same plugin instance so callers
 * can chain. Idempotent — a plugin that already declared a namespace is
 * returned untouched.
 */
function ensureNamespace(plugin: Plugin): Plugin {
  if (!plugin.namespace) {
    (plugin as { namespace?: string }).namespace = deriveNamespace(plugin.name);
  }
  return plugin;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
