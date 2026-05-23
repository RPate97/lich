import type { OwnedService } from '@lich/core';

/**
 * `api` service — Hono backend at `apps/api`. Depends on `postgres` so
 * `lich dev` brings it up after the DB is ready. `cwd` is relative to
 * the project root (where `lich dev` is invoked from).
 *
 * Moved from `packages/core/src/services/builtins.ts` into the hono plugin
 * (LEV-187 / Plan 16 Tier 3): the Hono backend was the only consumer of the
 * built-in api service, and ownership now follows the framework convention
 * that the plugin which provides an adapter also publishes the matching
 * `OwnedService` + env-source bundle. The legacy `envContributions` field is
 * gone — `hono.url` is now published via `api.addEnvSource('url', …)` in
 * `index.ts`.
 *
 * The `dependsOn: ['postgres']` entry references the postgres compose service
 * contributed by `@lich/plugin-postgres`. The runner's owned-service
 * ordering only checks names against the merged service set at run time, so
 * the dependency resolves correctly regardless of which plugin contributes
 * `postgres`.
 *
 * Re-exported from `@lich/plugin-hono` so callers that still need the
 * raw `OwnedService` shape (notably `commands/test.ts`, which derives
 * `API_URL` inline during the LEV-187 transition) can keep importing it.
 */
export const apiService: OwnedService = {
  name: 'api',
  kind: 'owned',
  portNames: ['api-http'],
  cwd: 'apps/api',
  command: 'bun run dev',
  dependsOn: ['postgres'],
  urlName: 'api',
};
