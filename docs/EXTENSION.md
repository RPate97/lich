# Extension Surface

Levelzero is built around eight pluggable **adapter slots**. The CLI, codegen, and runtime always go through these interfaces — never through a hard-coded vendor — so you can swap any slot for a custom impl without forking.

## The 8 adapter slots

| Slot | Purpose | Interface |
|---|---|---|
| `orm` | Migrations, schema introspection, seed, generated client | [`tools/cli/src/adapters/orm/types.ts`](../tools/cli/src/adapters/orm/types.ts) |
| `auth` | User creation, session signing, session inspection | [`tools/cli/src/adapters/auth/types.ts`](../tools/cli/src/adapters/auth/types.ts) |
| `ui` | Add/list design-system components | [`tools/cli/src/adapters/ui/types.ts`](../tools/cli/src/adapters/ui/types.ts) |
| `browser` | Headless screenshot + pixel diff for visual checks | [`tools/cli/src/adapters/browser/types.ts`](../tools/cli/src/adapters/browser/types.ts) |
| `backend` | Extract a route manifest from server source | [`tools/cli/src/adapters/backend/types.ts`](../tools/cli/src/adapters/backend/types.ts) |
| `frontend` | Generate a typed API client from a route manifest | [`tools/cli/src/adapters/frontend/types.ts`](../tools/cli/src/adapters/frontend/types.ts) |
| `test-runner` | Run a test suite and report pass/fail counts | [`tools/cli/src/adapters/test-runner/types.ts`](../tools/cli/src/adapters/test-runner/types.ts) |
| `portless` | Register/unregister public hostnames for local services | [`tools/cli/src/adapters/portless/types.ts`](../tools/cli/src/adapters/portless/types.ts) |

Exactly one impl per slot is **active** at a time; the registry can carry alternates (e.g. `prisma` and `drizzle` both registered under `orm`, with `prisma` active).

## Writing a custom adapter

An adapter is any object implementing the slot's interface. The slot is inferred from the method shape — or you can pin it explicitly with `slot: 'redis'` on the object (useful for new slots or shapes that collide with another slot).

## Registering a custom adapter

Add the plugin path to `adapters.custom` in `levelzero.config.ts`:

```ts
export default {
  adapters: {
    orm: 'prisma',
    custom: {
      'redis-cache': './plugins/redis-cache.ts',
    },
  },
};
```

At boot, `AdapterRegistry.loadCustomPlugins` dynamic-imports each path, picks `module.default ?? module[name] ?? module`, detects the slot, and registers it. The key (`'redis-cache'`) is the registered adapter `name`, **not** the slot.

## `levelzero adapter list` / `swap`

* `levelzero adapter list` — prints every (slot, name) in the registry with an `active` flag. Read-only.
* `levelzero adapter swap <slot> <name>` — validates the pair against the registry and persists the choice to `.levelzero/adapter.json`. Subsequent CLI runs read that file and call `setActive(slot, name)` before dispatching.

## Example: a 20-line Redis service adapter

```ts
// plugins/redis.ts
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });

export default {
  slot: 'portless',          // pin the slot explicitly
  name: 'redis',
  async available() {
    try { await client.connect(); return client.isOpen; }
    catch { return false; }
  },
  async register({ host, target }) {
    await client.hSet('levelzero:hosts', host, target);
  },
  async unregister(host) {
    await client.hDel('levelzero:hosts', host);
  },
  async list() {
    const all = await client.hGetAll('levelzero:hosts');
    return Object.entries(all).map(([host, target]) => ({ host, target }));
  },
};
```

Wire it in `levelzero.config.ts` under `adapters.custom`, then `levelzero adapter swap portless redis`.
