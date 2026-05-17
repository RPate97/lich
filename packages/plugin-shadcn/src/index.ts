import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { shadcnAdapter } from './adapter';
import { makeUiAddCommand } from './commands/add';
import { makeUiListCommand } from './commands/list';

export { shadcnAdapter } from './adapter';
export { makeUiAddCommand, uiAddCommand } from './commands/add';
export type { UiAddOptions } from './commands/add';
export { makeUiListCommand, uiListCommand } from './commands/list';
export type { UiListOptions } from './commands/list';

/**
 * `@levelzero/plugin-shadcn` — extracts the shadcn `UIAdapter` impl and its
 * `ui.add` / `ui.list` commands out of `@levelzero/core` (LEV-153).
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
 * bound to the shadcn adapter so `levelzero ui add button` and
 * `levelzero ui list` keep working unchanged.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-shadcn'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-shadcn',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addAdapter('ui', 'shadcn', shadcnAdapter);
    api.setActiveAdapter('ui', 'shadcn');
    api.addCommand(makeUiAddCommand({ adapter: shadcnAdapter }));
    api.addCommand(makeUiListCommand({ adapter: shadcnAdapter }));
  },
};

export default plugin;
