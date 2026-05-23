import type { Plugin, PluginAPI, PluginContext } from '@lich/core';
import { webService } from './service';

export { webService } from './service';

/**
 * Options for the `@lich/plugin-next` factory. The `namespace` override
 * exists so multi-instance setups can co-exist.
 */
export interface NextOptions {
  /** Override the default `'next'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@lich/plugin-next` — extracts the Next.js `web` owned-service builtin
 * out of `@lich/core` (LEV-154).
 *
 * Contributes a single `web` `OwnedService` via `api.addOwnedService`, with
 * the same shape the legacy core builtin published: `apps/web` working
 * directory, `bun run dev` command, dependency on `api`. The service
 * definition is also re-exported (`webService`) so commands that still need
 * the raw shape during the transition can import it directly.
 *
 * Also publishes the web URL as a named EnvSource under the `next` namespace
 * (LEV-187): consumers reference `next.url` from their config's
 * `envInjection` block. Host vs container resolvers diverge so a host-spawned
 * process sees `http://localhost:<allocated-port>` while a co-located compose
 * service sees `http://web:3000` (compose DNS).
 *
 * Wire it into a project by adding it to `lich.config.ts`:
 *
 * ```ts
 * import next from '@lich/plugin-next';
 *
 * export default {
 *   plugins: [next()],
 * };
 * ```
 */
export default function next(opts: NextOptions = {}): Plugin<
  'next',
  {
    named: 'url' | 'port';
    bulk: never;
  }
> {
  return {
    name: '@lich/plugin-next',
    namespace: (opts.namespace ?? 'next') as 'next',
    version: '0.1.0',

    register(api: PluginAPI<'next'>, _ctx: PluginContext): void {
      api.addOwnedService(webService);

      // EnvSource (LEV-187) — replace the legacy `envContributions` shape
      // that used to live on `webService`. Consumers reference `next.url`
      // from their config's `envInjection`.
      api.addEnvSource('url', {
        host: ({ ports }) => `http://localhost:${ports['web-http'] ?? ''}`,
        container: () => `http://web:3000`,
        protocol: 'http',
      });

      // LEV-200 — publish the allocated host port as a separate EnvSource so
      // the web template's `next dev --port "$WEB_PORT"` script can bind to
      // it (consumed as `WEB_PORT` via the template's
      // `envInjection: { WEB_PORT: 'next.port' }`). `next dev` does NOT read
      // `PORT` from env by default — it requires `--port <n>` on the CLI —
      // hence this separate source. Container context always reports `3000`
      // because a future containerized web service would listen on the
      // standard internal port.
      api.addEnvSource('port', {
        host: ({ ports }) => String(ports['web-http'] ?? ''),
        container: () => '3000',
      });
    },
  };
}
