import type { OwnedService, Service } from './types';
import { pgService } from './postgres';

/**
 * `api` service — Hono backend at `apps/api`. Depends on postgres so
 * `levelzero dev` brings it up after the DB is ready. `cwd` is relative to
 * the project root (where `levelzero dev` is invoked from).
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

export function getBuiltinServices(): Service[] {
  return [pgService, apiService, webService];
}
