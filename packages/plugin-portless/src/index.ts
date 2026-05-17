import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { portlessAdapter } from './portless';
import { noopPortlessAdapter } from './noop';

export { portlessAdapter } from './portless';
export { noopPortlessAdapter } from './noop';
export type { PortlessAdapter, URLEntry } from './types';

/**
 * `@levelzero/plugin-portless` — the pilot plugin extraction.
 *
 * Contributes two impls under the `portless` adapter slot:
 *
 *   - `portless` — shells out to the `portless` CLI on PATH.
 *   - `noop`     — fallback that reports unavailable and silently no-ops.
 *
 * The plugin marks `noop` active by default so consumers that call
 * `registry.getActive('portless')` never crash when portless isn't installed;
 * the `dev` command can probe `portlessAdapter.available()` and swap to the
 * real impl at runtime if the binary is found.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-portless'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-portless',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addAdapter('portless', 'portless', portlessAdapter);
    api.addAdapter('portless', 'noop', noopPortlessAdapter);
    api.setActiveAdapter('portless', 'noop');
  },
};

export default plugin;
