# Extension Surface

Levelzero is built around **plugins**. A plugin is the single unit of extension: it can contribute adapters, commands, owned services, compose services / volumes / networks, check rules, generators, and skills directories — all through one `register()` call during CLI bootstrap.

This page is the reference. For the actual interface, see [`packages/core/src/plugins/types.ts`](../packages/core/src/plugins/types.ts).

## What a plugin is

A plugin is any module that exports an object satisfying the `Plugin` contract:

```ts
export interface Plugin {
  name: string;
  version: string;
  register(api: PluginAPI, ctx: PluginContext): void | Promise<void>;
}
```

`register()` runs once per CLI invocation, with a `PluginAPI` (contribution surface) and a read-only `PluginContext` (`{ projectRoot, config }`). Sync or async — the loader awaits either.

## Plugin discovery

Plugins are **opt-in** via the `plugins` array in `levelzero.config.ts`:

```ts
import postgres from '@levelzero/plugin-postgres';

export default {
  plugins: [
    postgres,                              // Plugin object
    './plugins/redis.ts',                  // string specifier (local path or npm package)
    import('@levelzero/plugin-stripe'),    // Promise (typically a dynamic import)
  ],
};
```

Three entry shapes are accepted (see [`packages/core/src/config.ts`](../packages/core/src/config.ts) `PluginEntry`):

1. **Plugin object** — used as-is.
2. **String specifier** — a relative path (resolved against `projectRoot`) or a bare npm package name. The [loader](../packages/core/src/plugins/loader.ts) dynamic-imports it and picks `default`, a camelCased shorthand export, or the module itself.
3. **Promise** — awaited; `{ default: Plugin }` is unwrapped.

There is no auto-discovery: a plugin not listed in `plugins[]` is not loaded.

## PluginAPI surface

`PluginAPI` exposes ten contribution methods. Each is additive — re-registering with the same key overrides the previous entry; there is no removal method.

| Method | Purpose |
|---|---|
| `addAdapter(slot, name, impl)` | Register an adapter under a slot (`orm`, `auth`, `ui`, `browser`, `backend`, `frontend`, `test-runner`, `portless`). |
| `setActiveAdapter(slot, name)` | Mark one registered adapter as the active impl for its slot. |
| `addCommand(cmd)` | Register a CLI command for the dispatcher. |
| `addOwnedService(service)` | Declare a service whose lifecycle Levelzero owns. |
| `addComposeService(name, def)` | Contribute a compose v2 service to the merged stack. |
| `addComposeVolume(name, def)` | Contribute a named compose volume. |
| `addComposeNetwork(name, def)` | Contribute a named compose network. |
| `addRule(rule)` | Register a check rule consumed by `levelzero check`. |
| `addGenerator(gen)` | Register a code generator (typed clients, schemas, etc.). |
| `addSkillsDir(absPath)` | Expose a directory of skills to the agent. |

## Cross-plugin coordination

Plugins are processed **in declared order**. That ordering matters in two places:

- **`setActiveAdapter` is last-write-wins.** If two plugins both call `setActiveAdapter('orm', ...)`, the later one wins. Order your `plugins[]` so the plugin you want to "decide" comes last, or call `setActiveAdapter` in a project-local plugin to override.
- **Compose services / volumes / networks are keyed by name.** Two plugins contributing `addComposeService('postgres', ...)` collide; the later call replaces the earlier definition wholesale (no deep merge).

`addAdapter`, `addCommand`, `addRule`, `addGenerator`, and `addSkillsDir` are also last-write-wins on their natural key (slot+name, command name, rule id, generator id, absolute path).

A `register()` that throws aborts boot; the error is rewrapped with the offending plugin's `name` for attribution. See [`packages/core/src/plugins/boot.ts`](../packages/core/src/plugins/boot.ts) for the assembly order.

## Composability rule (READ THIS)

**Plugins compose through contracts, not through each other's internals.** If your plugin needs something another plugin provides, look it up through its slot interface — never import the other plugin's package.

Concrete cases:

- **ORM plugins** consume the active `DatabaseProvider` (which is contributed by whichever DB plugin is loaded — postgres, mysql, sqlite, mongo, …). The ORM is the one place where storage-engine-specific code lives (e.g. "drop schema" semantics). The CLI calls `orm.resetDatabase(ctx)`; the ORM dispatches internally on the provider's driver.
- **Auth plugins** consume the active ORM for user/session storage. They do NOT bring their own database driver.
- **Backend plugins** consume the active ORM (for typed handles), the active auth (for session middleware), and the active `DatabaseProvider` (for connection strings) — through context lookups, never through direct imports.
- **Frontend plugins** consume the active backend's route manifest.

Anti-patterns that fail review:

```ts
// ❌  Cross-plugin import (couples plugin-prisma to plugin-postgres)
import { pgService } from '@levelzero/plugin-postgres';
const databaseUrl = pgService.envContributions(entry.ports).DATABASE_URL;

// ✅  Capability lookup through the registry / context
const provider = ctx.getActiveDatabaseProvider();
const databaseUrl = provider.url();
```

```ts
// ❌  Storage-engine-specific SQL outside the implementation that owns it
import { Client } from 'pg';
await client.query('DROP SCHEMA public CASCADE');

// ✅  Generic operation on the slot interface; ORM dispatches internally
await orm.resetDatabase(ctx);
```

```jsonc
// ❌  Plugin package depends on a sibling stack plugin
{ "dependencies": { "@levelzero/plugin-postgres": "workspace:*" } }

// ✅  Plugins depend only on @levelzero/core
{ "peerDependencies": { "@levelzero/core": "*" } }
```

**The test for composability:** a combination we did not anticipate
(e.g. `plugin-drizzle` + `plugin-mongo` + `plugin-clerk` + `plugin-elysia`)
must work with zero changes to other plugins or to core, as long as each
implementation honors its slot contract.

## Worked example: a tiny Redis plugin

Runs Redis in compose, registers a `portless` adapter against it, and adds a `redis:ping` command:

```ts
// plugins/redis.ts
import type { Plugin } from '@levelzero/core';

export default {
  name: 'redis',
  version: '0.1.0',
  register(api) {
    api.addComposeService('redis', {
      image: 'redis:7-alpine',
      ports: ['${PORT}:6379'],
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '5s', retries: 5 },
    });
    api.addAdapter('portless', 'redis', {
      async available() { return true; },
      async register({ host, target }) { /* ... */ },
      async unregister(host) { /* ... */ },
      async list() { return []; },
    });
    api.setActiveAdapter('portless', 'redis');
    api.addCommand({ name: 'redis:ping', describe: 'Ping Redis', run: async () => { /* ... */ } });
  },
} satisfies Plugin;
```

Wire it in `levelzero.config.ts`: `export default { plugins: ['./plugins/redis.ts'] };`

## Command output: pretty by default, `--json` to opt in (LEV-168)

Every CLI command defaults to **pretty text** output. Pass `--json` on the invocation to get the structured shape instead. The two outputs must carry **the same fields** — `--json` is for piping; pretty is for humans.

Inside a `Command.run(ctx)` implementation:

```ts
import type { Command } from '@levelzero/core';

export const myCommand: Command = {
  name: 'mything.list',
  describe: 'List the things',
  async run(ctx) {
    const things = await collectThings();

    // JSON path — the CLI's `formatOutput` JSON-encodes the object verbatim.
    if (ctx.format === 'json') return { things };

    // Pretty path — return a string. The CLI passes strings through unchanged
    // (modulo trimming one trailing newline) so terminal output stays clean.
    if (things.length === 0) return 'no things\n';
    return things.map((t) => `${t.id}\t${t.name}`).join('\n') + '\n';
  },
};
```

The shape rules:

- Branch on `ctx.format === 'json'` to pick between the structured object and a `string`.
- The pretty string should end with a single `\n`; the CLI strips one trailing newline before writing to stdout, so a `'\n'`-terminated renderer gives you a single newline overall.
- Both paths should carry the same fields. Don't drop information just because pretty mode renders it as `key=value` instead of an object.
- Errors throw `CLIError(code, message, hint?)` exactly as before; `formatError` chooses `error: <msg>` / `hint: <text>` (pretty) vs the JSON shape (`--json`).

For a worked example see `packages/core/src/commands/env/list.ts` and the LEV-117 help renderer in `packages/core/src/commands/help.ts`.

## Publishing a plugin

External plugins ship as standalone npm packages. Versioning and changelog generation go through **changesets** (`.changeset/`). Build with **`tsup`** to emit dual ESM + CJS plus `.d.ts` declarations — the same template `@levelzero/core` uses. See [`docs/build-strategy.md`](./build-strategy.md) for the full decision and config template.

Each PR that introduces or bumps a plugin must include a changeset, and the package's `"main"` / `"module"` / `"types"` / `"exports"` must point at the `tsup` output with `@levelzero/core` pinned as a peer dependency.
