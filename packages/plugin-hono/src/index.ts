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
 * export default {
 *   plugins: ['@levelzero/plugin-hono'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-hono',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addAdapter('backend', 'hono', honoAdapter);
    api.setActiveAdapter('backend', 'hono');
  },
};

export default plugin;
