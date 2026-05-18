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

`PluginAPI` exposes twelve contribution methods. Each is additive — re-registering with the same key overrides the previous entry; there is no removal method.

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
| `addEnvSource(name, source)` | Publish one named value (e.g. a URL, port, driver string) under the plugin's namespace. |
| `addBulkEnvSource(source)` | Publish a `Record<string, string>` of values whose keys are determined at resolution time (dotenv, Infisical, AWS Secrets Manager). |

### `addEnvSource(name, source)`

Registers a **named EnvSource** under the plugin's declared namespace. The plugin author types the short local name (`'url'`); the framework composes the fully-qualified key (`${namespace}.${name}`, e.g. `postgres.url`) when storing the registration. Two plugins claiming the same `(namespace, name)` pair is a hard error at boot — the error names both plugins so consumers can attribute the collision.

A `source` provides two resolvers, both receiving the same `EnvSourceContext` (ports, projectRoot, worktreeKey, consumerContext):

- `host(ctx)` — value to use when the consumer is a host-spawned owned service (e.g. `next dev`). Typically `localhost:${ports.foo}`.
- `container(ctx)` — value to use when the consumer is a compose-managed service. Typically the compose-DNS form (`foo:5432`).
- `protocol` (optional) — open-ended identifier (`'postgres'`, `'redis'`, `'kafka'`, …) future tooling may dispatch on without coupling to any specific plugin.

Both resolvers may be sync or async. See the chapter on EnvSources in [plugin-author-guide.md](./plugin-author-guide.md) for a full walkthrough.

### `addBulkEnvSource(source)`

Registers a **bulk EnvSource** for the plugin's namespace. Used by secret-loader and config-loader plugins — anything where the available keys are determined by the upstream store at resolution time, not by the plugin author at code time. The `source.resolve(ctx)` callback returns a `Record<string, string>`; the keys of that record ARE the env var names a consumer can reference (either via `importAll: ['<namespace>']` or via an explicit `'<namespace>.<key>'` entry in `envInjection`).

A plugin may register **at most one** bulk source per namespace; a second registration is a hard error at boot. Bulk sources have no host/container distinction by default (a secret is the same value either way) — branch on `ctx.consumerContext` inside `resolve()` if you need it.

## Cross-plugin coordination

Plugins are processed **in declared order**. That ordering matters in two places:

- **`setActiveAdapter` is last-write-wins.** If two plugins both call `setActiveAdapter('orm', ...)`, the later one wins. Order your `plugins[]` so the plugin you want to "decide" comes last, or call `setActiveAdapter` in a project-local plugin to override.
- **Compose services / volumes / networks are keyed by name.** Two plugins contributing `addComposeService('postgres', ...)` collide; the later call replaces the earlier definition wholesale (no deep merge).

`addAdapter`, `addCommand`, `addRule`, `addGenerator`, and `addSkillsDir` are also last-write-wins on their natural key (slot+name, command name, rule id, generator id, absolute path).

A `register()` that throws aborts boot; the error is rewrapped with the offending plugin's `name` for attribution. See [`packages/core/src/plugins/boot.ts`](../packages/core/src/plugins/boot.ts) for the assembly order.

## Configuring env injection

Plugins **publish** values via `addEnvSource` / `addBulkEnvSource`. Consumers **wire** those values to env-var names by adding an `envInjection` block to `levelzero.config.ts`:

```ts
import { defineConfig } from '@levelzero/core';
import postgres from '@levelzero/plugin-postgres';
import redis    from '@levelzero/plugin-redis';
import dotenv   from '@levelzero/plugin-dotenv';
import infisical from '@levelzero/plugin-infisical';

export default defineConfig({
  plugins: [
    postgres(),
    redis(),
    dotenv(),                                         // bulk: dotenv
    infisical({ project: 'proj-abc', environment: 'dev' }), // bulk: infisical
  ],
  envInjection: {
    DATABASE_URL:  'postgres.url',                    // named (typed)
    REDIS_URL:     'redis.url',                       // named (typed)
    STRIPE_API_KEY:'infisical.STRIPE_API_KEY',        // explicit bulk key
    importAll:    ['dotenv', 'infisical'],            // every other key from these
  },
});
```

Rules (full algorithm in `packages/core/src/env/resolve.ts`):

- **Explicit entries always win over `importAll`.** `importAll` populates first; explicit `ENV_VAR: 'ns.name'` lines run after and overwrite anything they collide with.
- **Empty `envInjection` = nothing injected.** No magic auto-everything knob. If you want it, list it.
- **Bulk-source collisions inside `importAll`** (two bulk sources both define `STRIPE_API_KEY`) follow plugin load order: last wins. Override the loser with an explicit entry to make intent obvious.
- **Missing references fail fast at boot.** Reference `stripe.api_key` and no source provides it → `ENV_SOURCE_MISSING: ... did you forget to load @my-org/plugin-infisical?`. The error message lists every namespace the registry knows about.
- **Types autocomplete the right-hand side.** When the config is wrapped in `defineConfig({ ... })`, the `plugins` tuple flows through to `envInjection` — IDEs autocomplete `postgres.url` etc., and a typo (`'postgres.urll'`) is a compile error. The `importAll` array is constrained to namespaces of plugins that actually declared `bulk: true`.

### Host vs container resolution

Each consumer service gets its own resolution pass:

- **Host-spawned owned services** (e.g. `next dev`) — every named source resolves via its `host()` function. Values typically point at `localhost:${ports.<svc>}`.
- **Compose-managed services** — every named source resolves via its `container()` function. Values typically point at the compose-DNS form (`postgres:5432`, `redis:6379`). Bulk-source secrets are the same either way unless the resolver branches on `ctx.consumerContext`.

For inspection, every running service also has its merged env written to `.levelzero/state/<worktreeKey>/env/<service>.env`. `levelzero env list` and `levelzero env resolve <service>` print the same content from the CLI.

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
