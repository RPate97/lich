# @lich/plugin-redis

A Lich plugin that contributes a Redis service to your docker-compose
stack, publishes `redis.*` EnvSources (url/host/port/driver/password) for
downstream services, registers a small portless cache adapter, and adds a
`lich redis.ping` command.

Promoted from `examples/plugin-redis/` to a real workspace package (LEV-190).

## What the plugin does

| Contribution | Where |
|---|---|
| `addComposeService('redis', ...)` | [`src/compose.ts`](./src/compose.ts) |
| `addEnvSource('url' \| 'host' \| 'port' \| 'driver' \| 'password', ...)` | [`src/index.ts`](./src/index.ts) |
| `addAdapter('portless', 'redis-cache', ...)` + `setActiveAdapter` | [`src/adapter.ts`](./src/adapter.ts) |
| `addCommand({ name: 'redis.ping', ... })` | [`src/commands.ts`](./src/commands.ts) |
| Plugin entry / factory | [`src/index.ts`](./src/index.ts) |

The plugin is authored as a **factory** (LEV-179), so projects wire it in by
calling it: `plugins: [redis()]`. The factory accepts an optional
`{ image?, password?, namespace? }` for per-instance configuration.

The adapter declares `slot: 'portless'` explicitly — the documented escape
hatch for plugins that want to add a new boundary (here, a cache client)
without forking the core slot list. See the
[plugin author guide](../../docs/plugin-author-guide.md) for the longer
discussion.

## EnvSources

When loaded, the plugin publishes the following named EnvSources under the
`redis` namespace, addressable by downstream services as `redis.<name>`:

| Key | Host resolver | Container resolver |
|---|---|---|
| `redis.url` | `redis://[:<pw>@]localhost:<allocated-port>` | `redis://[:<pw>@]redis:6379` |
| `redis.host` | `localhost` | `redis` (compose service name) |
| `redis.port` | allocated host port (e.g. `49xxx`) | `6379` |
| `redis.driver` | `redis` | `redis` |
| `redis.password` | `opts.password ?? ''` | `opts.password ?? ''` |

`redis.url`'s `protocol` field is set to `'redis'` so future protocol-aware
tooling can dispatch on it.

## Quickstart — load it into a project

```ts
import type { LichConfig } from '@lich/core';
import redis from '@lich/plugin-redis';

export default {
  plugins: [redis()],
} satisfies LichConfig;
```

With a password:

```ts
plugins: [redis({ password: 'hunter2' })],
```

### Bring it up and ping it

```sh
# Start the stack — Redis now joins your compose services.
lich up

# In another shell, ping it.
lich redis.ping
# => PONG
```

By default the command targets `127.0.0.1:6379`. Override with `--host` /
`--port` flags or `REDIS_HOST` / `REDIS_PORT` env vars to point at the
stack-allocated host port reported by `lich stacks.current`.

```sh
# Read the allocated host port from the stack registry, then ping it.
PORT=$(lich stacks.current --format json | jq -r '.entry.ports.redis')
lich redis.ping --port "$PORT"
```

## What to read next

- [Plugin author guide](../../docs/plugin-author-guide.md) — narrated
  end-to-end walkthrough.
- [EXTENSION.md](../../docs/EXTENSION.md) — terse reference for every `addX`
  hook and the eight adapter slots.
- [`packages/core/src/plugins/types.ts`](../../packages/core/src/plugins/types.ts) —
  the `Plugin`, `PluginAPI`, and `PluginContext` source of truth.
- [`packages/core/src/env/types.ts`](../../packages/core/src/env/types.ts) —
  the `EnvSource` / `BulkEnvSource` contract.
