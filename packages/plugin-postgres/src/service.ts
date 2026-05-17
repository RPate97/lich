import type { DockerService } from './types';

/**
 * Legacy `DockerService` definition for postgres.
 *
 * Re-exported from `@levelzero/plugin-postgres` so callers that still drive the
 * dev/stop/reset pipeline through the `Service` abstraction (and the
 * `envContributions(ports) → { DATABASE_URL }` shape it carries) can continue
 * to import it during the LEV-148+ transition. New plugin authors should
 * prefer the compose contribution surface exposed via this plugin's
 * `register()`.
 *
 * Kept byte-identical to the previous `packages/core/src/services/postgres.ts`
 * so the extraction is a pure move: behaviour (image, env, healthcheck,
 * DATABASE_URL formatting) does not change.
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
  envContributions: (ports) => ({
    DATABASE_URL: `postgres://levelzero:levelzero@localhost:${ports.postgres}/levelzero`,
  }),
  healthCommand: ['pg_isready', '-U', 'levelzero', '-d', 'levelzero'],
};
