# @levelzero/example-plugin-redis

A worked example of a Levelzero plugin. Contributes a Redis service to your
docker-compose stack, registers a small cache adapter, and adds a
`levelzero redis.ping` command.

This package is shipped as an **example** — it isn't published to npm. Read
the source alongside the [plugin author guide](../../docs/plugin-author-guide.md)
and [EXTENSION.md](../../docs/EXTENSION.md) when building your own plugin.

## What the plugin does

| Contribution | Where |
|---|---|
| `addComposeService('redis', ...)` | [`src/compose.ts`](./src/compose.ts) |
| `addAdapter('portless', 'redis-cache', ...)` + `setActiveAdapter` | [`src/adapter.ts`](./src/adapter.ts) |
| `addCommand({ name: 'redis.ping', ... })` | [`src/commands.ts`](./src/commands.ts) |
| Plugin entry / wiring | [`src/index.ts`](./src/index.ts) |

The adapter declares `slot: 'portless'` explicitly — the documented escape
hatch for plugins that want to add a new boundary (here, a cache client)
without forking the core slot list. See the
[plugin author guide](../../docs/plugin-author-guide.md) for the longer
discussion.

## Quickstart — load it into a project

### Option A: relative path (local development)

In your project's `levelzero.config.ts`:

```ts
import type { LevelzeroConfig } from '@levelzero/core';

export default {
  plugins: ['../path/to/levelzero/examples/plugin-redis/src/index.ts'],
} satisfies LevelzeroConfig;
```

The loader resolves any specifier starting with `.` or `/` relative to your
project root and dynamic-imports it. See
[`tools/cli/src/plugins/loader.ts`](../../tools/cli/src/plugins/loader.ts).

### Option B: imported plugin object

If you already have the example checked out in a sibling directory, importing
the default export works too:

```ts
import redisPlugin from '../path/to/levelzero/examples/plugin-redis/src';

export default {
  plugins: [redisPlugin],
};
```

### Bring it up and ping it

```sh
# Start the stack — Redis now joins your compose services.
levelzero dev

# In another shell, ping it.
levelzero redis.ping
# => PONG
```

By default the command targets `127.0.0.1:6379`. Override with `--host` /
`--port` flags or `REDIS_HOST` / `REDIS_PORT` env vars to point at the
stack-allocated host port reported by `levelzero stacks.current`.

```sh
# Read the allocated host port from the stack registry, then ping it.
PORT=$(levelzero stacks.current --format json | jq -r '.entry.ports.redis')
levelzero redis.ping --port "$PORT"
```

## What to read next

- [Plugin author guide](../../docs/plugin-author-guide.md) — narrated
  end-to-end walkthrough.
- [EXTENSION.md](../../docs/EXTENSION.md) — terse reference for every `addX`
  hook and the eight adapter slots.
- [`tools/cli/src/plugins/types.ts`](../../tools/cli/src/plugins/types.ts) —
  the `Plugin`, `PluginAPI`, and `PluginContext` source of truth.
