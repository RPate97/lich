import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { webService } from './service';

export { webService } from './service';

/**
 * `@levelzero/plugin-next` — extracts the Next.js `web` owned-service builtin
 * out of `@levelzero/core` (LEV-154).
 *
 * Contributes a single `web` `OwnedService` via `api.addOwnedService`, with
 * the same shape the legacy core builtin published: `apps/web` working
 * directory, `bun run dev` command, dependency on `api`, and a `WEB_URL`
 * env contribution keyed off the `web-http` port. The service definition is
 * also re-exported (`webService`) so commands that still need the raw shape
 * during the transition — notably `levelzero test e2e`, which derives
 * `WEB_URL` from `webService.envContributions(ports)` — can import it
 * directly.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-next'],
 * };
 * ```
 *
 * Or by importing the default export directly:
 *
 * ```ts
 * import next from '@levelzero/plugin-next';
 *
 * export default {
 *   plugins: [next],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-next',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addOwnedService(webService);
  },
};

export default plugin;
