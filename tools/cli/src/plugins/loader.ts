import { isAbsolute, resolve, basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
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
  const candidate =
    (mod as { default?: unknown }).default ??
    (shorthand in mod ? (mod as Record<string, unknown>)[shorthand] : undefined) ??
    mod;

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
