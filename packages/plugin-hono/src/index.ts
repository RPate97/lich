import type { Plugin, PluginAPI, PluginContext } from '@lich/core';
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
 * Options for the `@lich/plugin-hono` factory. The `namespace` override
 * exists so multi-instance setups can co-exist.
 */
export interface HonoOptions {
  /** Override the default `'hono'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@lich/plugin-hono` — extracts the Hono `BackendAdapter` impl out of
 * `@lich/core`.
 *
 * Contributes:
 *
 *   - `hono` impl under the `backend` adapter slot (activated by default so
 *     existing consumers — route-coverage rule, the api-client generator
 *     dispatched by `lich gen`, etc. — keep observing the same
 *     behavior they did before the extraction);
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
 * Wire it into a project by adding it to `lich.config.ts`:
 *
 * ```ts
 * import hono from '@lich/plugin-hono';
 *
 * export default {
 *   plugins: [hono()],
 * };
 * ```
 */
export default function hono(opts: HonoOptions = {}): Plugin<
  'hono',
  {
    named: 'url' | 'port';
    bulk: never;
  }
> {
  return {
    name: '@lich/plugin-hono',
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

      // LEV-200 — publish the allocated host port as a separate EnvSource so
      // the api template can bind to it (consumed as `API_PORT` via the
      // template's `envInjection: { API_PORT: 'hono.port' }`). Container
      // context always reports `3000` because a future containerized api
      // service would listen on the standard internal port.
      api.addEnvSource('port', {
        host: ({ ports }) => String(ports['api-http'] ?? ''),
        container: () => '3000',
      });
    },
  };
}
