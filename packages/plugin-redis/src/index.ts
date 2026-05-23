import type { Plugin, PluginAPI, PluginContext, ComposeServiceDef } from '@lich/core';
import { redisComposeService } from './compose';
import { redisCacheAdapter } from './adapter';
import { redisPingCommand } from './commands';

/**
 * Options accepted by the `@lich/plugin-redis` factory.
 *
 *  - `image`     — Docker image tag, defaults to `redis:7-alpine`.
 *  - `password`  — optional auth password. When set, the compose service
 *                  starts with `--requirepass <pw>` and the published
 *                  `redis.url` includes `:<pw>@` userinfo.
 *  - `namespace` — override the default `redis` namespace if a project
 *                  needs to run two redis plugins side-by-side. Rarely
 *                  needed; the type-system tag `'redis'` keeps autocomplete
 *                  sharp for the common case.
 */
export interface RedisOptions {
  image?: string;
  password?: string;
  namespace?: string;
}

/**
 * `@lich/plugin-redis` — promoted from `examples/plugin-redis/` to a
 * real workspace package (LEV-190).
 *
 * Authored as a **factory** (LEV-179): consumers call `redis()` (optionally
 * with options) and pass the result into `lich.config.ts#plugins`.
 *
 * Contributions on each invocation:
 *
 *   1. `addComposeService('redis', …)` — Redis on a stack-allocated host
 *      port. Healthcheck is configured so other services can `depends_on:
 *      { redis: { condition: service_healthy } }`.
 *   2. `addEnvSource(…)` for `url`, `host`, `port`, `driver`, `password` —
 *      each scoped under the `redis` namespace and addressable as
 *      `redis.<name>` from `envInjection` in the consumer's config. `host`
 *      and `container` resolvers produce different values so a host-spawned
 *      Node worker sees `localhost:<allocated-port>` while a sibling
 *      compose service sees `redis:6379` (compose DNS).
 *   3. `addAdapter('portless', 'redis-cache', …)` + `setActiveAdapter` —
 *      portless escape hatch for the cache adapter contract. Preserved
 *      from the original example.
 *   4. `addCommand({ name: 'redis.ping' })` — `lich redis.ping`.
 *
 * Wire it into a project:
 *
 * ```ts
 * import redis from '@lich/plugin-redis';
 *
 * export default {
 *   plugins: [redis()],
 * };
 * ```
 */
export default function redis(opts: RedisOptions = {}): Plugin<
  'redis',
  {
    named: 'url' | 'host' | 'port' | 'driver' | 'password';
    bulk: never;
  }
> {
  return {
    name: '@lich/plugin-redis',
    namespace: (opts.namespace ?? 'redis') as 'redis',
    version: '0.1.0',

    register(api: PluginAPI<'redis'>, _ctx: PluginContext): void {
      // 1. Compose service — base definition from src/compose.ts, with
      //    optional image / password overrides spliced on top. `command` is
      //    not part of ComposeServiceDef's documented subset (see
      //    plugins/types.ts), so the password-mode override goes through an
      //    intersection cast at the addComposeService call site.
      const service: ComposeServiceDef = {
        ...redisComposeService,
        ...(opts.image ? { image: opts.image } : {}),
      };
      const passwordMode = opts.password
        ? { command: ['redis-server', '--requirepass', opts.password] }
        : {};
      api.addComposeService(
        'redis',
        { ...service, ...passwordMode } as ComposeServiceDef,
      );

      // 2. EnvSources — published under the plugin namespace. The framework
      //    composes the fully-qualified key, so callers see `redis.url`,
      //    `redis.host`, etc. Host vs container resolvers diverge so
      //    services co-located in compose hit `redis:6379` via compose DNS
      //    while host-spawned processes hit `localhost:<allocated-port>`.
      const password = opts.password ?? '';
      const userinfo = password ? `:${password}@` : '';

      api.addEnvSource('host', {
        host: () => 'localhost',
        container: () => 'redis',
      });

      api.addEnvSource('port', {
        host: ({ ports }) => String(ports.redis ?? ''),
        container: () => '6379',
      });

      api.addEnvSource('driver', {
        host: () => 'redis',
        container: () => 'redis',
      });

      api.addEnvSource('password', {
        host: () => password,
        container: () => password,
      });

      api.addEnvSource('url', {
        host: ({ ports }) => `redis://${userinfo}localhost:${ports.redis ?? ''}`,
        container: () => `redis://${userinfo}redis:6379`,
        protocol: 'redis',
      });

      // 3. Portless cache adapter — preserved from the original example.
      api.addAdapter('portless', 'redis-cache', redisCacheAdapter);
      api.setActiveAdapter('portless', 'redis-cache');

      // 4. `redis.ping` command.
      api.addCommand(redisPingCommand);
    },
  };
}

// Re-exports so downstream code can pull in the building blocks directly
// (helpful for tests and for projects that want to compose pieces without
// running the full factory).
export { redisComposeService } from './compose';
export { redisCacheAdapter } from './adapter';
export type { RedisCacheAdapter } from './adapter';
export { redisPingCommand } from './commands';
