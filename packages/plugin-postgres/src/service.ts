import type { DockerService } from './types';

/**
 * Legacy `DockerService` definition for postgres.
 *
 * Re-exported from `@levelzero/plugin-postgres` so callers that still drive the
 * dev/stop/reset pipeline through the `Service` abstraction can continue to
 * import it during the LEV-148+ transition. New plugin authors should prefer
 * the compose contribution surface exposed via this plugin's `register()`.
 *
 * The legacy `envContributions(ports) => { DATABASE_URL }` field was removed
 * in LEV-187. Consumers that need to build a connection URL outside the
 * EnvSource pipeline (e.g. the prisma `db.*` commands during the transition)
 * inline the formula instead — single source of truth lives in this plugin's
 * `addEnvSource('url', …)` registration.
 *
 * Kept otherwise byte-identical to the previous
 * `packages/core/src/services/postgres.ts` shape so behaviour (image,
 * container env, healthcheck) is unchanged.
 */
export const pgService: DockerService = {
  name: 'postgres',
  kind: 'docker',
  portNames: ['postgres'],
  image: 'postgres:16-alpine',
  containerEnv: {
    POSTGRES_USER: 'levelzero',
    POSTGRES_PASSWORD: 'levelzero',
    POSTGRES_DB: 'levelzero',
  },
  containerPortName: 'postgres',
  containerPortInContainer: 5432,
  volumeMountPath: '/var/lib/postgresql/data',
  healthCommand: ['pg_isready', '-U', 'levelzero', '-d', 'levelzero'],
};
