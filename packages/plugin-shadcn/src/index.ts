import type { Plugin, PluginAPI, PluginContext } from '@lich/core';
import { shadcnAdapter } from './adapter';
import { makeUiAddCommand } from './commands/add';
import { makeUiListCommand } from './commands/list';

export { shadcnAdapter } from './adapter';
export { makeUiAddCommand, uiAddCommand } from './commands/add';
export type { UiAddOptions } from './commands/add';
export { makeUiListCommand, uiListCommand } from './commands/list';
export type { UiListOptions } from './commands/list';

/**
 * Options for the `@lich/plugin-shadcn` factory. The `namespace` override
 * exists so multi-instance setups can co-exist.
 */
export interface ShadcnOptions {
  /** Override the default `'shadcn'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@lich/plugin-shadcn` — extracts the shadcn `UIAdapter` impl and its
 * `ui.add` / `ui.list` commands out of `@lich/core` (LEV-153).
 *
 * Contributes one impl under the `ui` adapter slot:
 *
 *   - `shadcn` — shells out to `npx shadcn@latest add` for component
 *     installation and reads `components.json` + the resolved components
 *     directory to list what's already installed.
 *
 * Activates `shadcn` by default so existing consumers that call
 * `registry.getActive('ui')` observe the same behavior they did before the
 * extraction. Also wires the `ui.add` and `ui.list` top-level commands, each
 * bound to the shadcn adapter so `lich ui add button` and
 * `lich ui list` keep working unchanged.
 *
 * Wire it into a project by adding it to `lich.config.ts`:
 *
 * ```ts
 * import shadcn from '@lich/plugin-shadcn';
 *
 * export default {
 *   plugins: [shadcn()],
 * };
 * ```
 */
export default function shadcn(opts: ShadcnOptions = {}): Plugin<
  'shadcn',
  {
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@lich/plugin-shadcn',
    namespace: (opts.namespace ?? 'shadcn') as 'shadcn',
    version: '0.1.0',

    register(api: PluginAPI<'shadcn'>, _ctx: PluginContext): void {
      api.addAdapter('ui', 'shadcn', shadcnAdapter);
      api.setActiveAdapter('ui', 'shadcn');
      api.addCommand(makeUiAddCommand({ adapter: shadcnAdapter }));
      api.addCommand(makeUiListCommand({ adapter: shadcnAdapter }));
    },
  };
}
