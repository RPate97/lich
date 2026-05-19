import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { typedClientFrontendAdapter } from './adapter';
import { apiClientGenerator } from './generator';

export { typedClientFrontendAdapter } from './adapter';
export { apiClientGenerator, makeApiClientGenerator } from './generator';

/**
 * Options for the `@levelzero/plugin-typed-client` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface TypedClientOptions {
  /** Override the default `'typed-client'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-typed-client` — extracted from core in LEV-151.
 *
 * Contributes:
 *
 *   - the `typed-client` impl under the `frontend` adapter slot — generates
 *     a fetch-based typed client from a `RouteManifest` produced by the
 *     active backend adapter; and
 *   - the `api-client` generator (LEV-124) — the codegen pipeline that
 *     `levelzero gen` drives. Ports the body of the retired `gen client`
 *     command into the unified Generator contract so other generators (e.g.
 *     plugin-prisma's `prisma generate`) can be run alongside it from one
 *     invocation.
 *
 * The plugin marks `typed-client` active so `gen` keeps producing output out
 * of the box for projects that include this plugin in their
 * `levelzero.config.ts` (this matches the pre-extraction default the core
 * registry installed).
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import typedClient from '@levelzero/plugin-typed-client';
 *
 * export default {
 *   plugins: [typedClient()],
 * };
 * ```
 */
export default function typedClient(opts: TypedClientOptions = {}): Plugin<
  'typed-client',
  {
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-typed-client',
    namespace: (opts.namespace ?? 'typed-client') as 'typed-client',
    version: '0.1.0',

    register(api: PluginAPI<'typed-client'>, _ctx: PluginContext): void {
      api.addAdapter('frontend', 'typed-client', typedClientFrontendAdapter);
      api.setActiveAdapter('frontend', 'typed-client');
      // LEV-124: contribute the `api-client` generator so `levelzero gen`
      // (which replaced the one-off `gen client`) can drive it through the
      // same dispatch path every other generator follows.
      api.addGenerator(apiClientGenerator);
    },
  };
}
