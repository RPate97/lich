# Plugin Author Guide

This is the end-to-end walkthrough for building your first Levelzero plugin. By the end you will have a working `redis-cache` plugin that contributes a compose service, a CLI command, and a healthcheck — installed locally in a sibling project and ready to publish to npm.

If you want the terse reference of every `addX` hook, see [EXTENSION.md](./EXTENSION.md). This document is the slower, narrated path.

## 1. Set up the package

A Levelzero plugin is just a normal Node package that exports an object satisfying the `Plugin` interface. Start with `bun init`:

```sh
mkdir my-plugin
cd my-plugin
bun init -y
```

`bun init` will create `package.json`, `index.ts`, and `tsconfig.json`. Rename or replace the generated `index.ts` — we'll write our own below.

## 2. Add `@levelzero/core` as a peerDependency

A plugin must not bundle its own copy of the core types. The host project owns the version, and the plugin is compiled against the same one. Edit `package.json`:

```json
{
  "name": "levelzero-plugin-redis-cache",
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
    "@levelzero/core": "^0.1.0"
  },
  "devDependencies": {
    "@levelzero/core": "^0.1.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

The `peerDependency` is the contract: any host project running your plugin must already have `@levelzero/core` installed. The matching `devDependency` is so your local TypeScript compiles cleanly.

## 3. Write the Plugin export

A `Plugin` has three fields — `name`, `version`, and a `register(api, ctx)` function — defined in [`packages/core/src/plugins/types.ts`](../packages/core/src/plugins/types.ts). The loader calls `register()` exactly once during CLI bootstrap, handing you a `PluginAPI` whose `addX` methods let you contribute to the running CLI.

Open `index.ts`:

```ts
import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';

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

    // addRule — register a check that `levelzero check` will run.
    // addAdapter / setActiveAdapter — contribute a custom adapter.
    // addOwnedService — register a long-running process the CLI manages.
    // addComposeVolume / addComposeNetwork — extend the compose topology.
    // addGenerator — plug into the codegen pipeline (LEV-124).
    // addSkillsDir — surface plugin-shipped /skill markdown files.

    // ctx.projectRoot is the host project's root (absolute path).
    // ctx.config is the loaded levelzero.config — narrow it yourself.
  },
};

export default plugin;
```

The loader picks your export in this precedence: `default` → camelCased basename (`redisCache`) → the module itself. Default-exporting is the simplest path and avoids surprises.

## 4. Test locally in a sibling project

Before publishing, point a real project at your local file. In a sibling repo, edit `levelzero.config.ts`:

```ts
import type { LevelzeroConfig } from '@levelzero/core';

export default {
  plugins: ['../my-plugin/index.ts'],
} satisfies LevelzeroConfig;
```

Any specifier starting with `.` or `/` is treated as a local path and resolved relative to the project root (see [`loader.ts`](../packages/core/src/plugins/loader.ts)). Run a CLI command and confirm your plugin booted:

```sh
levelzero adapter list
levelzero cache.flush
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

The repo-wide build strategy is documented in [build-strategy.md](./build-strategy.md): every published `@levelzero/*` (and plugin) package uses `tsup` to emit dual ESM + CJS plus `.d.ts`. A minimal `tsup.config.ts`:

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

The Levelzero repo uses [changesets](https://github.com/changesets/changesets) for SemVer bumps and changelogs. From your plugin package:

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
npm install levelzero-plugin-redis-cache
```

```ts
// levelzero.config.ts
export default {
  plugins: ['levelzero-plugin-redis-cache'],
};
```

The loader resolves bare specifiers through Node's algorithm rooted at the project's `package.json`, so workspace hoisting and monorepo layouts work without extra config.

## What to read next

- [EXTENSION.md](./EXTENSION.md) — terse reference for the 8 adapter slots and every `addX` hook.
- [`packages/core/src/plugins/types.ts`](../packages/core/src/plugins/types.ts) — the source of truth for the `Plugin`, `PluginAPI`, and `PluginContext` contracts.
- [`packages/core/src/plugins/loader.ts`](../packages/core/src/plugins/loader.ts) — how local-path and npm specifiers are resolved.
- [build-strategy.md](./build-strategy.md) — full rationale for the tsup-based publish flow.
