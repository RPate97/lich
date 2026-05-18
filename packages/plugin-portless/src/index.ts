import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { portlessAdapter } from './portless';
import { noopPortlessAdapter } from './noop';

export { portlessAdapter } from './portless';
export { noopPortlessAdapter } from './noop';
export type { PortlessAdapter, URLEntry } from './types';

/**
 * Options for the `@levelzero/plugin-portless` factory. The `namespace`
 * override exists so multi-instance setups can co-exist; it's reserved for
 * Plan 16 (LEV-186 onward) and not exercised today.
 */
export interface PortlessOptions {
  /** Override the default `'portless'` namespace for multi-instance use. */
  namespace?: string;
}

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
 * import portless from '@levelzero/plugin-portless';
 *
 * export default {
 *   plugins: [portless()],
 * };
 * ```
 *
 * The factory shape (LEV-186) is the seam for future per-instance options
 * — for now the only knob is `namespace`, used for the multi-instance case.
 */
export default function portless(opts: PortlessOptions = {}): Plugin<
  'portless',
  {
    // Filled in by LEV-187 once portless publishes EnvSources.
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-portless',
    namespace: (opts.namespace ?? 'portless') as 'portless',
    version: '0.1.0',

    register(api: PluginAPI<'portless'>, _ctx: PluginContext): void {
      api.addAdapter('portless', 'portless', portlessAdapter);
      api.addAdapter('portless', 'noop', noopPortlessAdapter);
      api.setActiveAdapter('portless', 'noop');
    },
  };
}
