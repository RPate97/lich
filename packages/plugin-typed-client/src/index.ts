import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { typedClientFrontendAdapter } from './adapter';

export { typedClientFrontendAdapter } from './adapter';

/**
 * `@levelzero/plugin-typed-client` — extracted from core in LEV-151.
 *
 * Contributes a single impl under the `frontend` adapter slot:
 *
 *   - `typed-client` — generates a fetch-based typed client from a
 *     `RouteManifest` produced by the active backend adapter.
 *
 * The plugin marks `typed-client` active so `gen client` keeps working out of
 * the box for projects that include this plugin in their `levelzero.config.ts`
 * (this matches the pre-extraction default the core registry installed).
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-typed-client'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-typed-client',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addAdapter('frontend', 'typed-client', typedClientFrontendAdapter);
    api.setActiveAdapter('frontend', 'typed-client');
  },
};

export default plugin;
