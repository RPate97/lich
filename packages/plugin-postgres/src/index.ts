import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { postgresComposeService, postgresPgdataVolume } from './compose';

export { pgService } from './service';
export { postgresComposeService, postgresPgdataVolume } from './compose';

/**
 * Options for the `@levelzero/plugin-postgres` factory. The `namespace`
 * override exists so multi-instance setups can co-exist (e.g. two postgres
 * instances under different namespaces).
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
 * Also publishes the connection parameters as named EnvSources under the
 * `postgres` namespace (LEV-187): consumers reference `postgres.url`,
 * `postgres.host`, `postgres.port`, `postgres.user`, `postgres.password`,
 * `postgres.database`, and `postgres.driver` from their config's
 * `envInjection` block. Host vs container resolvers diverge so a host-spawned
 * Node worker sees `localhost:<allocated-port>` while a sibling compose
 * service sees `postgres:5432` (compose DNS).
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
    named: 'url' | 'host' | 'port' | 'user' | 'password' | 'database' | 'driver';
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

      // EnvSources (LEV-187) — replace the legacy `envContributions` shape.
      // The framework qualifies each name with the plugin namespace, so
      // consumers see `postgres.host`, `postgres.url`, etc. Host vs container
      // resolvers diverge so co-located compose services hit `postgres:5432`
      // (compose DNS) while host-spawned processes hit
      // `localhost:<allocated-port>`.
      api.addEnvSource('host', {
        host: () => 'localhost',
        container: () => 'postgres',
      });
      api.addEnvSource('port', {
        host: ({ ports }) => String(ports.postgres ?? ''),
        container: () => '5432',
      });
      api.addEnvSource('user', {
        host: () => 'levelzero',
        container: () => 'levelzero',
      });
      api.addEnvSource('password', {
        host: () => 'levelzero',
        container: () => 'levelzero',
      });
      api.addEnvSource('database', {
        host: () => 'levelzero',
        container: () => 'levelzero',
      });
      api.addEnvSource('driver', {
        host: () => 'postgresql',
        container: () => 'postgresql',
      });
      api.addEnvSource('url', {
        host: ({ ports }) =>
          `postgres://levelzero:levelzero@localhost:${ports.postgres ?? ''}/levelzero`,
        container: () => `postgres://levelzero:levelzero@postgres:5432/levelzero`,
        protocol: 'postgres',
      });
    },
  };
}
