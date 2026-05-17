import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { redisComposeService } from './compose';
import { redisCacheAdapter } from './adapter';
import { redisPingCommand } from './commands';

/**
 * `@levelzero/example-plugin-redis` — the canonical worked example.
 *
 * Demonstrates three contribution patterns in one plugin:
 *
 *   1. `addComposeService('redis', ...)` — drops a Redis service into the
 *      generated docker-compose.yml so `levelzero dev` brings it up.
 *   2. `addAdapter('portless', 'redis-cache', ...)` + `setActiveAdapter` —
 *      registers a custom adapter. The adapter declares `slot: 'portless'`
 *      explicitly; this is the documented escape hatch for plugins that want
 *      to add a new boundary (here, a cache client) without forking the core
 *      slot list. See the plugin author guide section on the `slot` field.
 *   3. `addCommand({ name: 'redis.ping', ... })` — wires a top-level
 *      subcommand so `levelzero redis.ping` returns `PONG`.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import redisPlugin from '@levelzero/example-plugin-redis';
 *
 * export default {
 *   plugins: [redisPlugin],
 * };
 * ```
 *
 * Or by path during local development:
 *
 * ```ts
 * export default {
 *   plugins: ['../path/to/examples/plugin-redis/src/index.ts'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: 'example-plugin-redis',
  version: '0.0.0',

  register(api: PluginAPI, _ctx: PluginContext) {
    // 1. Compose service — Redis on a stack-allocated host port.
    api.addComposeService('redis', redisComposeService);

    // 2. Adapter — register under the `portless` slot via the explicit
    //    `slot` annotation, then mark it active so consumers that call
    //    `registry.getActive('portless')` get this impl.
    api.addAdapter('portless', 'redis-cache', redisCacheAdapter);
    api.setActiveAdapter('portless', 'redis-cache');

    // 3. Command — `levelzero redis.ping`.
    api.addCommand(redisPingCommand);
  },
};

export default plugin;
