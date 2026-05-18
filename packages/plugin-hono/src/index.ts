import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { honoBackendAdapter } from './adapter';

export { honoBackendAdapter } from './adapter';
export type { HonoExtractRoutesOptions } from './adapter';

/**
 * Alias for {@link honoBackendAdapter}. Exposes the canonical short name the
 * Plugin registers under the `backend` slot (matches the LEV-150 contract:
 * `api.addAdapter('backend', 'hono', honoAdapter)`). Existing consumers that
 * import `honoBackendAdapter` keep working — both names point at the same
 * object.
 */
export const honoAdapter = honoBackendAdapter;

/**
 * Options for the `@levelzero/plugin-hono` factory. The `namespace` override
 * exists so multi-instance setups can co-exist.
 */
export interface HonoOptions {
  /** Override the default `'hono'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-hono` — extracts the Hono `BackendAdapter` impl out of
 * `@levelzero/core`.
 *
 * Contributes one impl under the `backend` adapter slot:
 *
 *   - `hono` — dynamically imports `apps/api/src/index.ts` and reads
 *     `app.routes` off the default-exported Hono instance to produce a
 *     `RouteManifest`.
 *
 * Activates `hono` by default so existing consumers (route-coverage rule,
 * gen client, etc.) keep observing the same behavior they did before the
 * extraction.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import hono from '@levelzero/plugin-hono';
 *
 * export default {
 *   plugins: [hono()],
 * };
 * ```
 */
export default function hono(opts: HonoOptions = {}): Plugin<
  'hono',
  {
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-hono',
    namespace: (opts.namespace ?? 'hono') as 'hono',
    version: '0.1.0',

    register(api: PluginAPI<'hono'>, _ctx: PluginContext): void {
      api.addAdapter('backend', 'hono', honoAdapter);
      api.setActiveAdapter('backend', 'hono');
    },
  };
}
