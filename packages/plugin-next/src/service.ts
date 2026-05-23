import type { OwnedService } from '@lich/core';

/**
 * `web` service — Next.js frontend at `apps/web`. Depends on `api` so URLs
 * are registered in dependency order. `cwd` is relative to the project root.
 *
 * Re-exported from `@lich/plugin-next` so callers that still need the
 * raw `OwnedService` definition (notably `commands/test.ts`, which derives
 * `WEB_URL` inline during the LEV-187 transition) can keep importing it.
 * New plugin authors should instead express the contribution through this
 * plugin's `register()`.
 *
 * The legacy `envContributions` field was removed in LEV-187 — `next.url`
 * is now published via `api.addEnvSource('url', …)` in `index.ts`.
 */
export const webService: OwnedService = {
  name: 'web',
  kind: 'owned',
  portNames: ['web-http'],
  cwd: 'apps/web',
  command: 'bun run dev',
  dependsOn: ['api'],
  urlName: 'web',
};
