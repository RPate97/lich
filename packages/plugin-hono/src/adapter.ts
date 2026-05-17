import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BackendAdapter,
  RouteEntry,
  RouteManifest,
} from '@levelzero/core';

/**
 * Options for {@link honoBackendAdapter.extractRoutes}. Most consumers will
 * rely on the default entry path; the option exists primarily for tests and
 * future flexibility (e.g. monorepos with a non-standard app layout).
 */
export interface HonoExtractRoutesOptions {
  /** Path to the app entry, relative to `projectRoot`. Defaults to `apps/api/src/index.ts`. */
  entry?: string;
}

const DEFAULT_ENTRY = 'apps/api/src/index.ts';

const HTTP_METHODS: ReadonlySet<RouteEntry['method']> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/**
 * Minimal shape of a Hono `RouterRoute`. We deliberately type it loosely so
 * this adapter doesn't take a hard dependency on Hono's internal types; the
 * runtime contract (an array of `{method, path, handler}`) is stable across
 * Hono versions.
 */
interface HonoRouterRoute {
  method: string;
  path: string;
  handler?: unknown;
}

interface HonoAppLike {
  routes?: HonoRouterRoute[];
}

function isHonoMethod(method: string): method is RouteEntry['method'] {
  return HTTP_METHODS.has(method as RouteEntry['method']);
}

/** Try to derive a stable handler symbol from the registered handler fn. */
function handlerNameOf(handler: unknown): string | undefined {
  if (typeof handler !== 'function') return undefined;
  const name = (handler as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  // Anonymous arrow/function expressions sometimes get assigned a name by the
  // JS engine (e.g. variable name); we keep those, but skip Hono-internal
  // wrappers that show up as `bound dispatch` or similar.
  if (name === 'anonymous' || name.startsWith('bound ')) return undefined;
  return name;
}

export const honoBackendAdapter: BackendAdapter & {
  extractRoutes(
    projectRoot: string,
    options?: HonoExtractRoutesOptions,
  ): Promise<RouteManifest>;
} = {
  name: 'hono',
  async extractRoutes(
    projectRoot: string,
    options: HonoExtractRoutesOptions = {},
  ): Promise<RouteManifest> {
    const entryRel = options.entry ?? DEFAULT_ENTRY;
    const entryAbs = join(projectRoot, entryRel);

    if (!existsSync(entryAbs)) {
      throw new Error(
        `honoBackendAdapter: entry file not found at ${entryAbs} ` +
          `(looked for ${entryRel} under ${projectRoot})`,
      );
    }

    // Cache-bust the dynamic import so repeated calls during tests/dev pick up
    // edits. Mirrors the pattern used by loadConfig in src/config.ts.
    const url = `file://${entryAbs}?t=${Date.now()}`;
    let mod: { default?: unknown };
    try {
      mod = (await import(url)) as { default?: unknown };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `honoBackendAdapter: failed to dynamically import ${entryAbs}: ${msg}`,
      );
    }

    const app = mod.default as HonoAppLike | undefined;
    if (!app || typeof app !== 'object') {
      throw new Error(
        `honoBackendAdapter: ${entryAbs} has no default export ` +
          `(expected: \`export default app\` where \`app\` is a Hono instance)`,
      );
    }

    const rawRoutes = Array.isArray(app.routes) ? app.routes : [];

    const seen = new Set<string>();
    const routes: RouteEntry[] = [];
    for (const r of rawRoutes) {
      if (!r || typeof r !== 'object') continue;
      const methodRaw = typeof r.method === 'string' ? r.method.toUpperCase() : '';
      const path = typeof r.path === 'string' ? r.path : '';
      if (!path) continue;
      // Skip framework-internal `ALL` middleware entries (e.g. global `app.use`
      // wrappers); we only emit explicit HTTP verb routes.
      if (!isHonoMethod(methodRaw)) continue;
      const key = `${methodRaw} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: RouteEntry = { method: methodRaw, path };
      const handlerName = handlerNameOf(r.handler);
      if (handlerName) entry.handlerName = handlerName;
      routes.push(entry);
    }

    return {
      generatedAt: new Date().toISOString(),
      routes,
    };
  },
};
