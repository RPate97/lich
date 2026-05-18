import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { honoBackendAdapter } from './adapter';
import { apiService } from './service';

export { honoBackendAdapter } from './adapter';
export type { HonoExtractRoutesOptions } from './adapter';
export { apiService } from './service';

/**
 * Alias for {@link honoBackendAdapter}. Exposes the canonical short name the
 * Plugin registers under the `backend` slot (matches the LEV-150 contract:
 * `api.addAdapter('backend', 'hono', honoAdapter)`). Existing consumers that
 * import `honoBackendAdapter` keep working — both names point at the same
 * object.
 */
export const honoAdapter = honoBackendAdapter;

/**
 * Options for the `@levelzero/plugin-hono` factory. The `namespace` override
 * exists so multi-instance setups can co-exist.
 */
export interface HonoOptions {
  /** Override the default `'hono'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-hono` — extracts the Hono `BackendAdapter` impl out of
 * `@levelzero/core`.
 *
 * Contributes:
 *
 *   - `hono` impl under the `backend` adapter slot (activated by default so
 *     existing consumers — route-coverage rule, gen client, etc. — keep
 *     observing the same behavior they did before the extraction);
 *   - the `api` owned service (`apps/api`, `bun run dev`), promoted out of
 *     `packages/core/src/services/builtins.ts` so the plugin that provides
 *     the backend adapter also owns the service definition (LEV-187); and
 *   - a single named EnvSource under the `hono` namespace — `hono.url` —
 *     publishing the base URL the api service serves at. Host vs container
 *     resolvers diverge so a host-spawned process sees
 *     `http://localhost:<allocated-port>` while a co-located compose service
 *     sees `http://api:3000` (compose DNS placeholder for any future
 *     sibling-service plumbing).
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import hono from '@levelzero/plugin-hono';
 *
 * export default {
 *   plugins: [hono()],
 * };
 * ```
 */
export default function hono(opts: HonoOptions = {}): Plugin<
  'hono',
  {
    named: 'url';
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-hono',
    namespace: (opts.namespace ?? 'hono') as 'hono',
    version: '0.1.0',

    register(api: PluginAPI<'hono'>, _ctx: PluginContext): void {
      api.addAdapter('backend', 'hono', honoAdapter);
      api.setActiveAdapter('backend', 'hono');
      api.addOwnedService(apiService);

      // EnvSource (LEV-187) — replace the legacy `envContributions` shape that
      // used to live on `apiService` in `core/src/services/builtins.ts`.
      // Consumers reference `hono.url` from their config's `envInjection`.
      api.addEnvSource('url', {
        host: ({ ports }) => `http://localhost:${ports['api-http'] ?? ''}`,
        container: () => `http://api:3000`,
        protocol: 'http',
      });
    },
  };
}
