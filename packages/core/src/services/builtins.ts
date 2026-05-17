import type { OwnedService, Service } from './types';

/**
 * `api` service — Hono backend at `apps/api`. Depends on postgres so
 * `levelzero dev` brings it up after the DB is ready. `cwd` is relative to
 * the project root (where `levelzero dev` is invoked from).
 *
 * The `dependsOn: ['postgres']` entry is preserved even though postgres is no
 * longer a built-in `Service` (post-LEV-148 it ships as a compose contribution
 * from `@levelzero/plugin-postgres`). The runner's owned-service ordering only
 * checks names against the merged service set at run time; the plugin will
 * have added `postgres` to that set by then.
 */
export const apiService: OwnedService = {
  name: 'api',
  kind: 'owned',
  portNames: ['api-http'],
  cwd: 'apps/api',
  command: 'bun run dev',
  dependsOn: ['postgres'],
  urlName: 'api',
  envContributions: (ports) => ({
    API_URL: `http://localhost:${ports['api-http']}`,
  }),
};

/**
 * `web` service — Next.js frontend at `apps/web`. Depends on `api` so URLs
 * are registered in dependency order. `cwd` is relative to the project root.
 */
export const webService: OwnedService = {
  name: 'web',
  kind: 'owned',
  portNames: ['web-http'],
  cwd: 'apps/web',
  command: 'bun run dev',
  dependsOn: ['api'],
  urlName: 'web',
  envContributions: (ports) => ({
    WEB_URL: `http://localhost:${ports['web-http']}`,
  }),
};

/**
 * The default service list `dev`/`stop`/`reset` inject when the caller doesn't
 * provide one. Postgres is no longer included here — it ships as a compose
 * contribution from `@levelzero/plugin-postgres` (LEV-148). Consumers that
 * still need the legacy `pgService` `DockerService` (notably the db.* commands
 * that derive `DATABASE_URL` from `pgService.envContributions`) import it
 * directly from `@levelzero/plugin-postgres`.
 */
export function getBuiltinServices(): Service[] {
  return [apiService, webService];
}
