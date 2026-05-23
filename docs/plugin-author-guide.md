# Plugin Author Guide

This is the end-to-end walkthrough for building your first Lich plugin. By the end you will have a working `redis-cache` plugin that contributes a compose service, a CLI command, and a healthcheck — installed locally in a sibling project and ready to publish to npm.

If you want the terse reference of every `addX` hook, see [EXTENSION.md](./EXTENSION.md). This document is the slower, narrated path.

## 1. Set up the package

A Lich plugin is just a normal Node package that exports an object satisfying the `Plugin` interface. Start with `bun init`:

```sh
mkdir my-plugin
cd my-plugin
bun init -y
```

`bun init` will create `package.json`, `index.ts`, and `tsconfig.json`. Rename or replace the generated `index.ts` — we'll write our own below.

## 2. Add `@lich/core` as a peerDependency

A plugin must not bundle its own copy of the core types. The host project owns the version, and the plugin is compiled against the same one. Edit `package.json`:

```json
{
  "name": "lich-plugin-redis-cache",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "peerDependencies": {
    "@lich/core": "^0.1.0"
  },
  "devDependencies": {
    "@lich/core": "^0.1.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

The `peerDependency` is the contract: any host project running your plugin must already have `@lich/core` installed. The matching `devDependency` is so your local TypeScript compiles cleanly.

## 3. Write the Plugin export

A `Plugin` has three fields — `name`, `version`, and a `register(api, ctx)` function — defined in [`packages/core/src/plugins/types.ts`](../packages/core/src/plugins/types.ts). The loader calls `register()` exactly once during CLI bootstrap, handing you a `PluginAPI` whose `addX` methods let you contribute to the running CLI.

Open `index.ts`:

```ts
import type { Plugin, PluginAPI, PluginContext } from '@lich/core';

const plugin: Plugin = {
  name: 'redis-cache',
  version: '0.1.0',
  async register(api: PluginAPI, ctx: PluginContext) {
    // Each addX call below registers one contribution. The methods are
    // additive — call as many as you need, in any order.

    // addComposeService — append a service to the generated docker-compose.yml.
    api.addComposeService('redis', {
      image: 'redis:7-alpine',
      ports: ['${PORT}:6379'],
      healthcheck: {
        test: ['CMD', 'redis-cli', 'ping'],
        interval: '5s',
        timeout: '3s',
        retries: 5,
      },
    });

    // addCommand — wire a new top-level subcommand into the CLI.
    api.addCommand({
      name: 'cache.flush',
      describe: 'Flush the redis cache',
      async run({ cwd, format }) {
        // Real impl would shell out to `redis-cli flushall` or
        // talk to the running container via the compose network.
        return { ok: true };
      },
    });

    // addRule — register a check that `lich check` will run.
    // addAdapter / setActiveAdapter — contribute a custom adapter.
    // addOwnedService — register a long-running process the CLI manages.
    // addComposeVolume / addComposeNetwork — extend the compose topology.
    // addGenerator — plug into the codegen pipeline (LEV-124).
    // addSkillsDir — surface plugin-shipped /skill markdown files.

    // ctx.projectRoot is the host project's root (absolute path).
    // ctx.config is the loaded lich.config — narrow it yourself.
  },
};

export default plugin;
```

The loader picks your export in this precedence: `default` → camelCased basename (`redisCache`) → the module itself. Default-exporting is the simplest path and avoids surprises.

## 4. Test locally in a sibling project

Before publishing, point a real project at your local file. In a sibling repo, edit `lich.config.ts`:

```ts
import type { LichConfig } from '@lich/core';

export default {
  plugins: ['../my-plugin/index.ts'],
} satisfies LichConfig;
```

Any specifier starting with `.` or `/` is treated as a local path and resolved relative to the project root (see [`loader.ts`](../packages/core/src/plugins/loader.ts)). Run a CLI command and confirm your plugin booted:

```sh
lich adapter list
lich cache.flush
```

If `register()` throws, the CLI rewraps the error as `plugin "redis-cache" failed during register(): <reason>` so you know exactly which plugin to fix.

You can also pass a `Plugin` object directly (skip the file altogether) or a `Promise<Plugin>` — useful when a plugin needs async setup before it's ready to register.

## 5. Add a compose service contribution (worked example)

The `redis` service we registered in step 3 is the worked example. A few details worth highlighting:

- **Port strings use `${PORT}`** on the host side. The runner substitutes a stack-allocated port at compose-render time, so multiple stacks don't collide. The container side (`6379`) is fixed by the image.
- **Healthchecks matter.** A service without a healthcheck blocks `depends_on: { condition: service_healthy }` consumers from ever starting cleanly. Always include one for any service another service might wait on.
- **Last write wins.** If two plugins both call `addComposeService('redis', ...)`, the later one overrides. Order is determined by the `plugins:` array in the config.
- The `ComposeServiceDef` type is intentionally a subset of compose v2 — `image`, `build`, `ports`, `environment`, `volumes`, `depends_on`, `healthcheck`. More fields are added as plugins need them.

## 6. Add a command contribution

The `cache.flush` command above is the minimum: a dot-separated name, a `describe` string, and an async `run(ctx)`. The `CommandContext` gives you:

- `cwd` — the directory the user invoked from.
- `format` — `'text'` or `'json'` (respect this; return structured data when format is `'json'`).
- `args` — positional arguments after the subcommand.
- `flags` — parsed `--key=value` and `--bool` flags.

Return any value from `run()`; the dispatcher prints it according to `format`. Throw to signal failure — the dispatcher catches and renders the error.

Names use dots for namespacing (`cache.flush`, `db.migrate`, `auth.user.create`) so the dispatcher can route subcommand trees without registering every leaf.

## 7. Publish flow

Once your plugin works locally, publish it so other projects can install it from npm.

### Build with tsup

The repo-wide build strategy is documented in [build-strategy.md](./build-strategy.md): every published `@lich/*` (and plugin) package uses `tsup` to emit dual ESM + CJS plus `.d.ts`. A minimal `tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
```

Add a script: `"build": "tsup"`. Then `bun run build` produces `dist/index.js`, `dist/index.cjs`, and `dist/index.d.ts`.

### Use changesets for versioning

The Lich repo uses [changesets](https://github.com/changesets/changesets) for SemVer bumps and changelogs. From your plugin package:

```sh
bunx changeset            # describe the change interactively
bunx changeset version    # bump package.json and write CHANGELOG.md
git commit -am "release"
bunx changeset publish    # publish to npm and tag
```

`changeset publish` will only push packages whose version is newer than what's on the registry, so it's safe to run repeatedly.

### Install in a consumer

Once published, host projects install your plugin like any npm dep and reference it by name:

```sh
npm install lich-plugin-redis-cache
```

```ts
// lich.config.ts
export default {
  plugins: ['lich-plugin-redis-cache'],
};
```

The loader resolves bare specifiers through Node's algorithm rooted at the project's `package.json`, so workspace hoisting and monorepo layouts work without extra config.

## 8. EnvSource — publishing values for services to consume

The most common reason a plugin exists is to stand up some piece of infrastructure (a database, a cache, an auth provider, a secret store) and then **tell the rest of the stack how to reach it**. The contract for that second half is the **EnvSource** system (Plan 16): plugins publish values, the consumer's `lich.config.ts` maps them to env-var names, and the runtime injects them into both host-spawned services and compose-managed containers.

Two shapes are supported — pick whichever matches what your plugin actually knows.

### 8.1 Named EnvSource — for specific known values

Use `api.addEnvSource(name, source)` when your plugin produces **one specific value the consumer can reference by name** — a service URL, a port number, a driver string, a single curated secret.

```ts
api.addEnvSource('url', {
  host:      ({ ports }) => `postgres://u:p@localhost:${ports.postgres}/db`,
  container: ()          => `postgres://u:p@postgres:5432/db`,
  protocol:  'postgres',
});
```

The plugin types the **short local name** (`'url'`). The framework composes the fully-qualified key (`postgres.url`) using the plugin's declared namespace and stores it in the boot-scoped `EnvSourceRegistry`. Two plugins claiming the same `(namespace, name)` pair is a hard error at boot.

Each source has two resolvers — `host(ctx)` and `container(ctx)` — both receiving the same `EnvSourceContext` (`ports`, `projectRoot`, `worktreeKey`, `consumerContext`). The framework picks which one to call based on whether the consumer service is host-spawned or compose-managed; see §8.3.

`protocol` is open-ended metadata (`'postgres'`, `'redis'`, `'kafka'`, an arbitrary string for novel protocols). Future tooling may dispatch on it; today it shows up in `lich env list`.

### 8.2 Bulk EnvSource — for whatever-you-find collections

Use `api.addBulkEnvSource(source)` when your plugin loads **a `Record<string, string>` whose keys aren't known until resolution** — dotenv files, Infisical/Vault folders, AWS Secrets Manager prefixes, anything where the upstream store determines the namespace contents.

```ts
api.addBulkEnvSource({
  resolve: async ({ projectRoot }) => {
    const secrets = await client.listSecrets({ folder, environment });
    return Object.fromEntries(secrets.map(s => [s.key, s.value]));
  },
});
```

The returned record's **keys ARE the env var names** a consumer can ask for. No host/container split by default (a secret is the same value either way); branch on `ctx.consumerContext` inside `resolve()` if you really need to. A plugin may register **at most one** bulk source per namespace.

Consumers pull bulk values in two ways from `envInjection`:

- `importAll: ['mynamespace']` — every key the source produces shows up as an env var.
- `'ENV_VAR': 'mynamespace.SOME_KEY'` — pick a single key from the bulk source.

Explicit entries always win over `importAll` (see §8.7).

### 8.3 Host vs container resolution

Each consumer service gets its own resolution pass driven by the service kind:

- **Host-spawned owned services** (Next dev, Vite dev, a custom Node worker) — every named source resolves via `host()`. Values typically look like `localhost:${ports.<svc>}` so the host process can reach the stack-allocated port published by the compose service.
- **Compose-managed services** — every named source resolves via `container()`. Values typically use compose-DNS form (`postgres:5432`, `redis:6379`) since the container is on the same compose network as its dependencies.

Implications when writing a resolver:

- Read everything you need off `ctx`. Don't capture closure state at `register()` time that depends on ports or worktree paths — both are only known at resolution.
- `ctx.ports` is the fully-resolved `portName -> hostPort` map. For a compose service you contributed yourself, the port name matches the compose key (`ports.redis` for a service named `redis`).
- Both resolvers may be sync or async. The runtime awaits either.
- Bulk resolvers receive the context too. Branch on `ctx.consumerContext` if (rarely) a secret should differ between host and container; otherwise ignore it.

### 8.4 Worktree-safe state

Two paths matter, and they are not the same:

- `ctx.projectRoot` — the absolute path to the consumer's **main repository root**. The same value regardless of which worktree the user invoked from. Secret-source plugins (dotenv, Infisical, Vault) read config from here so a `.env.local` in the main workspace is read by every worktree's `lich up` without copying.
- `ctx.worktreeKey` — a stable short identifier of the **active worktree**. Plugins that need worktree-scoped state (per-worktree caches, ephemeral tokens) scope it under `.lich/state/<worktreeKey>/`.

Default to `projectRoot` for anything config-shaped (paths to look up secrets, paths to a schema file). Reach for `worktreeKey` only when the state is genuinely worktree-local — usually that means it's regenerated cheaply if it disappears.

### 8.5 Worked example — writing a secret-source plugin

The shortest interesting plugin: load `secrets.json` from the project root and publish every key under a `json-secrets` namespace.

```ts
// packages/my-org-plugin-json-secrets/src/index.ts
import type { Plugin, PluginAPI, PluginContext } from '@lich/core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Options accepted by the @my-org/plugin-json-secrets factory.
 *  - `file`      — path relative to `ctx.projectRoot`. Default `secrets.json`.
 *  - `namespace` — override the default `json-secrets` namespace (rare).
 */
export interface JsonSecretsOptions {
  file?: string;
  namespace?: string;
}

export default function jsonSecrets(
  opts: JsonSecretsOptions = {},
): Plugin<'json-secrets', { named: never; bulk: true }> {
  // Capture defaults once at factory-call time so the resolver closure
  // doesn't re-default on every boot.
  const file = opts.file ?? 'secrets.json';

  return {
    name: '@my-org/plugin-json-secrets',
    namespace: (opts.namespace ?? 'json-secrets') as 'json-secrets',
    version: '0.1.0',

    register(api: PluginAPI<'json-secrets'>, _ctx: PluginContext): void {
      api.addBulkEnvSource({
        // `projectRoot` (NOT a worktree path) is what makes this safe for
        // sibling worktrees — every worktree reads the same secrets.json
        // out of the main repo.
        resolve: ({ projectRoot }) => {
          const abs = resolve(projectRoot, file);
          if (!existsSync(abs)) return {};
          return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, string>;
        },
      });
    },
  };
}
```

A consumer wires it up in `lich.config.ts`:

```ts
import { defineConfig } from '@lich/core';
import jsonSecrets from '@my-org/plugin-json-secrets';

export default defineConfig({
  plugins: [jsonSecrets()],
  envInjection: {
    importAll: ['json-secrets'],          // every key from secrets.json
    // OR pick individual ones:
    // STRIPE_KEY: 'json-secrets.STRIPE_KEY',
  },
});
```

The behavior to notice:

- `Plugin<'json-secrets', { named: never; bulk: true }>` — the namespace literal flows through to `defineConfig()` so consumers get `'json-secrets'` autocomplete in `importAll`.
- A missing `secrets.json` is a silent no-op (returns `{}`). Loud failures during boot are reserved for actually-broken configurations; missing optional files are the common path.
- No fs reads at factory-call time. Everything happens inside `resolve()` so the plugin works in test fixtures that never touch a real file system.

That's the full plugin in ~20 lines. The dotenv plugin in `packages/plugin-dotenv/src/index.ts` is the next size up — file precedence, optional `process.env` overlay, allowlists — and is worth reading once you start adding options.

### 8.6 Plugin factory options pattern

Every Plan 16 plugin is a **factory**: the default export is a function returning the `Plugin` object. This is what lets `[postgres(), infisical({ ... })]` exist in a config — the consumer parameterises the plugin at call site.

The convention is:

```ts
export interface MyPluginOptions {
  // …per-option fields with JSDoc comments…
  namespace?: string;
}

export default function myPlugin(
  opts: MyPluginOptions = {},
): Plugin<'my-plugin', { named: '…' | '…'; bulk: never /* or true */ }> {
  // Resolve defaults ONCE at factory-call time. The returned Plugin's
  // closures capture stable values; resolvers don't re-default on every
  // boot.
  const value = opts.value ?? 'default';

  return {
    name: '@my-org/plugin-my-plugin',
    namespace: (opts.namespace ?? 'my-plugin') as 'my-plugin',
    version: '0.1.0',
    register(api, ctx) { /* … */ },
  };
}
```

Three details that recur:

- **`namespace` cast.** The override path (`opts.namespace ?? 'my-plugin'`) makes TS widen to `string`; the `as 'my-plugin'` keeps the namespace literal sharp for `defineConfig()` autocomplete. The cast is safe because the literal is the default; downstream consumers who pass a different namespace knowingly lose autocomplete on that instance.
- **Default `opts = {}`.** Makes `myPlugin()` callable without arguments. Plugins with required options (`infisical({ project, environment })`) drop the default.
- **Internal escape hatches use `_`-prefixed fields.** See `plugin-infisical`'s `_clientFactory` — a test seam for mocking the SDK. The underscore signals "do not use in production"; readers can grep the codebase to confirm.

### 8.7 Type-level declaration — `Plugin<NS, S>`

The return type carries two parameters the rest of the system uses for inference:

```ts
Plugin<'my-plugin', { named: 'url' | 'host' | 'port'; bulk: false }>
```

- `NS` is the namespace string literal. It must match the value assigned to `namespace` at runtime (the cast in §8.6 keeps them aligned).
- `S extends SourceManifest` describes what the plugin publishes. `named` is the union of local names you'll register via `addEnvSource`; `bulk` is `true` if you'll call `addBulkEnvSource`. Use `never` for the slot you don't use.

`defineConfig()` flows the plugins tuple through to `envInjection`:

```ts
import { defineConfig } from '@lich/core';
import postgres from '@lich/plugin-postgres';
import myPlugin from '@my-org/plugin-my-plugin';

export default defineConfig({
  plugins: [postgres(), myPlugin()],
  envInjection: {
    DATABASE_URL: 'postgres.url',  // autocomplete from the postgres manifest
    SERVICE_URL:  'my-plugin.url', // autocomplete from your manifest
    // 'my-plugin.urll' — compile error: typo
    // importAll: ['my-plugin']   — compile error: bulk is false
  },
});
```

If the manifest is wrong (you typed `named: 'url'` but the plugin actually calls `addEnvSource('host', …)`), the registration is still accepted at runtime — the manifest is purely a type-level contract. Keep the type and the runtime calls in sync; it's the only thing consumers of the plugin can see in their IDE.

### 8.8 Testing EnvSources

The pattern is the same for both shapes: build a recording `PluginAPI`, call your plugin's `register()`, then assert on the captured sources.

```ts
import { describe, it, expect, vi } from 'vitest';
import type { EnvSource, EnvSourceContext, PluginAPI } from '@lich/core';
import myPlugin from '../src/index';

function makeRecordingApi(): { api: PluginAPI<'my-plugin'>; sources: Record<string, EnvSource> } {
  const sources: Record<string, EnvSource> = {};
  const api: PluginAPI<'my-plugin'> = {
    addEnvSource: (name, source) => { sources[name] = source; },
    addBulkEnvSource: vi.fn(),
    addAdapter: vi.fn(),
    setActiveAdapter: vi.fn(),
    addCommand: vi.fn(),
    addOwnedService: vi.fn(),
    addComposeService: vi.fn(),
    addComposeVolume: vi.fn(),
    addComposeNetwork: vi.fn(),
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
  };
  return { api, sources };
}

function makeCtx(overrides: Partial<EnvSourceContext> = {}): EnvSourceContext {
  return {
    ports: { 'my-plugin': 51234 },
    projectRoot: '/tmp/example',
    worktreeKey: 'abc12345',
    consumerContext: 'host',
    ...overrides,
  };
}

describe('myPlugin', () => {
  it('publishes the url source with diverging host/container values', async () => {
    const { api, sources } = makeRecordingApi();
    await myPlugin().register(api, { projectRoot: '/tmp/example', config: {} });

    expect(await sources.url.host(makeCtx())).toBe('myproto://localhost:51234');
    expect(await sources.url.container(makeCtx({ consumerContext: 'container' })))
      .toBe('myproto://my-plugin:1234');
  });
});
```

Patterns worth picking up from the shipping plugins:

- **Test resolvers directly, not via the framework.** Construct an `EnvSourceContext`, call `source.host(ctx)` / `source.container(ctx)`, assert on the string. No need to spin up a real registry — that's the framework's job and already has its own tests in `packages/core`.
- **Use `vi.fn()` for unused `PluginAPI` methods.** Accidental new contributions show up in your assertions instead of silently registering. `packages/plugin-redis/tests/index.test.ts` is the canonical recorder.
- **For bulk sources, inject filesystem / network seams.** dotenv stubs the file system via temp directories; infisical injects `_clientFactory`. Either way the test stays hermetic — no real fs/network/SDK calls.
- **Cover the "missing inputs" path.** A bulk source that finds no file / no secrets should return `{}`, not throw. A named source whose port isn't allocated yet should either throw a clear error or return a sentinel — pick one and test it.

### 8.9 Where to look in the tree

Real shipping examples, in order of complexity:

- `packages/plugin-redis/src/index.ts` — named sources for `url`, `host`, `port`, `driver`, `password`. Both host and container resolvers; one source carries a `protocol`. The "minimum interesting named-source plugin" reference.
- `packages/plugin-dotenv/src/index.ts` — bulk source with file precedence + optional `process.env` overlay. Reads from `ctx.projectRoot`.
- `packages/plugin-infisical/src/index.ts` — bulk source backed by an external SDK. Demonstrates the `_clientFactory` test seam and credential-missing error handling.
- `packages/plugin-kafka/src/index.ts` — non-URL protocol; published as a bootstrap-server list, exercises the open-ended `Protocol` type.

The framework side is small enough to read end-to-end:

- `packages/core/src/env/types.ts` — `EnvSource`, `BulkEnvSource`, `EnvSourceContext`, `SourceManifest`.
- `packages/core/src/env/registry.ts` — collection + collision detection at boot.
- `packages/core/src/env/resolve.ts` — the full algorithm (bulk pre-resolve, `importAll`, explicit-wins).
- `packages/core/src/define-config.ts` — the type-level inference that connects a plugins tuple to `envInjection` autocomplete.

## What to read next

- [EXTENSION.md](./EXTENSION.md) — terse reference for the 8 adapter slots and every `addX` hook, including the env-injection consumer rules.
- [`packages/core/src/plugins/types.ts`](../packages/core/src/plugins/types.ts) — the source of truth for the `Plugin`, `PluginAPI`, and `PluginContext` contracts.
- [`packages/core/src/plugins/loader.ts`](../packages/core/src/plugins/loader.ts) — how local-path and npm specifiers are resolved.
- [`packages/core/src/env/types.ts`](../packages/core/src/env/types.ts) — `EnvSource` / `BulkEnvSource` / `EnvSourceContext` reference.
- [build-strategy.md](./build-strategy.md) — full rationale for the tsup-based publish flow.
- [Plan 16 architecture record](./superpowers/plans/2026-05-17-levelzero-16-env-injection.md) — the why behind the design.
