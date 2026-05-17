---
name: writing-plugins
description: How to write a levelzero plugin (contribute adapters, commands, compose services, generators, rules)
applies-to: reference
---

# Writing a levelzero plugin

A levelzero plugin is a module that contributes to the running CLI:
adapters, commands, compose services, generators, rules, and skill
directories. The CLI loads plugins listed in `.levelzero/config.ts` and
calls each one's `register()` exactly once during bootstrap.

The full contract lives in `packages/core/src/plugins/types.ts` — read that
file before writing a plugin. The summary below mirrors it.

## The `Plugin` interface

```ts
export interface Plugin {
  name: string;
  version: string;
  register(api: PluginAPI, ctx: PluginContext): void | Promise<void>;
}
```

`PluginContext` gives you `{ projectRoot: string; config: unknown }` —
both immutable for the duration of the call. Narrow `config` yourself
if you need to read it.

## The `PluginAPI` surface

Every method registers a contribution under a unique key. The API is
additive — there is no removal. Override an adapter by re-registering
the same name; compose the merged result downstream for everything else.

- `addAdapter(slot, name, impl)` — register an adapter implementation
  for a slot (`auth`, `orm`, `backend`, `frontend`, `browser`).
- `setActiveAdapter(slot, name)` — pick which adapter the stack uses
  for that slot.
- `addCommand(cmd)` — contribute a `levelzero <cmd>` subcommand.
- `addOwnedService(service)` — register a long-running service the CLI
  owns (lifecycle managed by `levelzero dev` / `stop`).
- `addComposeService(name, def)` — contribute a Docker Compose v2
  service. Use `"${PORT}:<container>"` for ports so the runner can
  allocate per-worktree.
- `addComposeVolume(name, def)` / `addComposeNetwork(name, def)` —
  named compose volumes and networks.
- `addRule(rule)` — register a conformance rule run by `levelzero check`.
- `addGenerator(gen)` — register a code generator surfaced via
  `levelzero gen.<id>`.
- `addSkillsDir(absPath)` — add a directory of skill markdown files;
  the indexer merges them into the generated CLAUDE.md.

## Minimal example

```ts
// plugins/redis/index.ts
import type { Plugin } from '@levelzero/core';

export const redisPlugin: Plugin = {
  name: 'redis',
  version: '0.1.0',
  register(api) {
    api.addComposeService('redis', {
      image: 'redis:7-alpine',
      ports: ['${PORT}:6379'],
      healthcheck: {
        test: ['CMD', 'redis-cli', 'ping'],
        interval: '5s',
        retries: 5,
      },
    });
  },
};
```

## Registering the plugin

In `.levelzero/config.ts`:

```ts
import { defineConfig } from '@levelzero/core';
import { redisPlugin } from './plugins/redis';

export default defineConfig({
  plugins: [redisPlugin],
});
```

Plugins load in array order. Later plugins see earlier contributions
already merged, but cannot observe them through `PluginAPI` — read
`ctx.config` for cross-plugin coordination.

## See also

- `examples/plugin-redis/` — full walkthrough of a plugin that
  contributes a compose service, an owned service, and a command.
- `packages/core/src/plugins/types.ts` — the source of truth.
