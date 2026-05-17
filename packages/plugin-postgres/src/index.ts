import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { postgresComposeService, postgresPgdataVolume } from './compose';

export { pgService } from './service';
export { postgresComposeService, postgresPgdataVolume } from './compose';

/**
 * `@levelzero/plugin-postgres` — extracts the postgres builtin out of
 * `@levelzero/core` (LEV-148).
 *
 * Contributes a `postgres` compose service plus the `pgdata` named volume the
 * service mounts at `/var/lib/postgresql/data`. The contribution shape mirrors
 * what the legacy `pgService` `DockerService` (still exported from this
 * package for db-command consumers during the transition) produced through
 * `dockerServiceToCompose` — same image, same env, same healthcheck — but
 * goes through the modern `addComposeService` API so this plugin can be
 * authored without depending on the `Service` abstraction.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-postgres'],
 * };
 * ```
 *
 * Or by importing the default export directly:
 *
 * ```ts
 * import postgres from '@levelzero/plugin-postgres';
 *
 * export default {
 *   plugins: [postgres],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-postgres',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addComposeService('postgres', postgresComposeService);
    api.addComposeVolume('pgdata', postgresPgdataVolume);
  },
};

export default plugin;
