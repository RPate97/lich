import type { OwnedService } from '@levelzero/core';

/**
 * `web` service — Next.js frontend at `apps/web`. Depends on `api` so URLs
 * are registered in dependency order. `cwd` is relative to the project root.
 *
 * Re-exported from `@levelzero/plugin-next` so callers that still need the
 * raw `OwnedService` definition (notably the `levelzero test e2e` command,
 * which reads `webService.envContributions(ports)` to derive `WEB_URL`) can
 * keep importing it during the LEV-154+ transition. New plugin authors
 * should instead express the contribution through this plugin's `register()`.
 *
 * Kept byte-identical to the previous `packages/core/src/services/builtins.ts`
 * `webService` constant so the extraction is a pure move: behaviour (cwd,
 * command, dependsOn, urlName, env contributions) does not change.
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
