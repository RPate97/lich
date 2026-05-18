import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { postgresComposeService, postgresPgdataVolume } from './compose';

export { pgService } from './service';
export { postgresComposeService, postgresPgdataVolume } from './compose';

/**
 * Options for the `@levelzero/plugin-postgres` factory. The `namespace`
 * override exists so multi-instance setups can co-exist (e.g. two postgres
 * instances under different namespaces). The `S` source-manifest is stubbed
 * out today — LEV-187 fills in the real env-source keys.
 */
export interface PostgresOptions {
  /** Override the default `'postgres'` namespace for multi-instance use. */
  namespace?: string;
}

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
 * import postgres from '@levelzero/plugin-postgres';
 *
 * export default {
 *   plugins: [postgres()],
 * };
 * ```
 */
export default function postgres(opts: PostgresOptions = {}): Plugin<
  'postgres',
  {
    // Filled in by LEV-187 (e.g. 'url' | 'host' | 'port' | 'database' | 'driver').
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-postgres',
    namespace: (opts.namespace ?? 'postgres') as 'postgres',
    version: '0.1.0',

    register(api: PluginAPI<'postgres'>, _ctx: PluginContext): void {
      api.addComposeService('postgres', postgresComposeService);
      api.addComposeVolume('pgdata', postgresPgdataVolume);
    },
  };
}
