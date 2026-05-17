# Plan 14 — Plugin architecture: core + plugin packages

**Goal:** Split levelzero from a single-package monolith into a plugin-driven framework. Ship `@levelzero/core` (orchestration + plugin protocol), extract every stack-coupled adapter/command/service into its own plugin package, and replace the inline `docker run` orchestration with Docker Compose so plugins contribute compose fragments rather than running their own containers. Templates remain a separate concept — they scaffold projects that declare which plugins to use.

**Why now:**
- Current CLI mixes framework primitives (`dev`, `test`, `impact`) with stack-coupled commands (`curl --as`, `ui.add`, `db.*`). Projects on different stacks can't use levelzero without ripping out commands they don't need.
- `CommandRegistry` is already shape-extensible but there's no loader for project-local commands — only `adapters.custom` is plumbed (LEV-104).
- Docker container management is done by hand (`tools/cli/src/docker/runner.ts`). Compose would replace ~all of that with declarative config and give operators standard tooling (`docker compose ps/logs/exec`).
- Versioning is currently lockstep with the levelzero monorepo; independent plugin versions via changesets opens up incremental plugin updates.

---

## Architecture

### Composability principle (design north star)

**Plugins compose through contracts, not through each other's specific
implementations.** When plugin A needs something plugin B provides, A talks to
B through B's *slot interface*, never through B's package internals. A plugin
in slot X must work with any plugin in slot Y as long as both conform to their
slot's contract.

Concretely, for the slots we have today:

- The **db plugin** (postgres/mysql/sqlite/mongo/…) is the single source of
  truth for "what is the database connection". It exposes a `DatabaseProvider`
  capability: `{ url(): string, driver(): 'postgresql'|'mysql'|'sqlite'|'mongodb'|…, ready(): Promise<void> }`.
- The **ORM plugin** (prisma/drizzle/mongoose/…) consumes whichever
  `DatabaseProvider` is active. It NEVER imports the postgres plugin (or any
  other DB plugin) directly. Operations that conceptually depend on the
  storage engine — `resetDatabase`, `applyMigrations`, `inspectSchema` —
  live INSIDE the ORM adapter. The ORM is free to dispatch internally on
  `provider.driver()` if it needs to, but the calling command sees only
  `orm.resetDatabase(ctx)`.
- The **auth plugin** (better-auth/clerk/auth.js/…) consumes the active ORM
  (and through it, the active DB) for its user/session storage. It NEVER
  brings its own database driver to the party.
- The **backend plugin** (hono/express/elysia/…) consumes the active ORM
  for typed handles, the active auth for session middleware, and the
  `DatabaseProvider` for connection URLs. It does not import any specific
  ORM/auth/DB plugin.
- The **frontend plugin** (typed-client/openapi/trpc/…) consumes the active
  backend's route manifest. It does not assume hono.

**Test for composability:** a new plugin combination that we did not
anticipate (e.g. `plugin-drizzle` + `plugin-mongo` + `plugin-clerk` +
`plugin-elysia`) MUST work without a single line change to any other
plugin or to core — as long as each implementation honors its slot
contract.

**Anti-patterns to flag in review:**

1. A plugin's `package.json` listing another stack-specific plugin
   (`@levelzero/plugin-postgres`, `@levelzero/plugin-prisma`, etc.) as
   a `dependency` or `peerDependency`. Plugins depend on `@levelzero/core`
   only.
2. Raw SQL or driver-specific code (e.g. `import { Client } from 'pg'`,
   `client.query('DROP SCHEMA …')`) anywhere outside the plugin that
   owns the implementation detail.
3. A command in core (or in plugin X) reaching into plugin Y's package by
   import to derive runtime values. Cross-plugin information flows through
   `ctx.getAdapterRegistry()` / `ctx.getDatabaseProvider()` / similar
   capability lookups, never through `import { foo } from '@levelzero/plugin-Y'`.
4. A slot interface leaking a specific implementation's assumptions
   (e.g. an `ORMContext` field named `postgresSchema`). Slot interfaces
   are written from the consumer's point of view, not the
   most-convenient-first-implementation's.

**Where this principle is enforced:** during code review (look for the
anti-patterns), during plugin tests (each plugin's tests should NOT
instantiate or import any other plugin), and via lint rules where
practical (e.g. forbidding cross-plugin imports in `packages/plugin-*/`).

**Where this principle is currently violated** (tracked in tickets):

- `plugin-prisma`'s `resetDatabase` uses `pg` directly to issue
  `DROP SCHEMA public CASCADE` (postgres-specific). The drop semantics
  should live inside the ORM and dispatch on `provider.driver()`.
- `plugin-prisma`'s `db.*` commands import `pgService` from
  `@levelzero/plugin-postgres` to derive `DATABASE_URL`. They should
  consume the active `DatabaseProvider` via context.
- `plugin-better-auth` hardcodes `better-sqlite3` and rejects any
  non-sqlite URL. It should consume the active ORM (which in turn
  consumes the active DB).
- See LEV-122 (auth↔ORM), LEV-123 (db reset semantics), LEV-169
  (umbrella composability epic — file me).

### Plugin protocol
Single hook: each plugin exports a `register(api, ctx)` function. The `api` exposes typed contribution points:

```ts
// @levelzero/core/plugin.ts
export interface PluginAPI {
  // Adapters (slots from AdapterRegistry)
  addAdapter(slot: AdapterSlot, name: string, impl: unknown): void;
  setActiveAdapter(slot: AdapterSlot, name: string): void;

  // Commands (CommandRegistry)
  addCommand(cmd: Command): void;

  // Runtime services
  addOwnedService(service: OwnedService): void;
  addComposeService(name: string, def: ComposeServiceDef): void;
  addComposeVolume(name: string, def: ComposeVolumeDef): void;
  addComposeNetwork(name: string, def: ComposeNetworkDef): void;

  // Other registries
  addRule(rule: Rule): void;
  addGenerator(gen: Generator): void;
  addSkillsDir(absPath: string): void;
}

export interface PluginContext {
  projectRoot: string;
  config: LevelzeroConfig;
  logger: Logger;
}

export interface Plugin {
  name: string;        // npm package name or local path identifier
  version: string;
  register(api: PluginAPI, ctx: PluginContext): void | Promise<void>;
}
```

### Plugin discovery
Opt-in only. `levelzero.config.ts` declares `plugins: [...]`:

```ts
import postgres from '@levelzero/plugin-postgres';
import prisma from '@levelzero/plugin-prisma';
import hono from '@levelzero/plugin-hono';
import betterAuth from '@levelzero/plugin-better-auth';
import shadcn from '@levelzero/plugin-shadcn';
import next from '@levelzero/plugin-next';
import vitest from '@levelzero/plugin-vitest';
import playwright from '@levelzero/plugin-playwright';
import redis from './local-plugins/redis';  // project-local works too

export default {
  name: 'my-app',
  plugins: [postgres, prisma, hono, betterAuth, shadcn, next, vitest, playwright, redis],
};
```

No `node_modules` scanning. No auto-discovery. Plugins load in declared order; later plugins can override earlier ones (e.g., `setActiveAdapter` is last-write-wins).

### Docker Compose orchestration
Plugins contribute compose fragments. At `levelzero dev`:
1. Walk all registered compose services/volumes/networks.
2. Emit `<worktree>/.levelzero/docker-compose.yml`.
3. Run `docker compose -p levelzero-<key> up -d`.
4. Wait on declared healthchecks (compose handles this via `depends_on: condition: service_healthy`).
5. Start owned services (api/web/etc.) after compose services report healthy.

`stop` → `docker compose -p levelzero-<key> down`.
`reset` → `docker compose -p levelzero-<key> down -v`.

The existing `tools/cli/src/docker/` directory mostly gets deleted. The `Service` type becomes:
```ts
type Service = OwnedService;   // managed processes (bun run dev)
// docker services become compose contributions, not Service instances
```

### Workspace layout (Turborepo monorepo + changesets)
```
levelzero/                                    # workspace root
  package.json                                # private; workspaces config
  turbo.json
  .changeset/
  packages/
    core/                                     # @levelzero/core
      package.json
      src/                                    # most of today's tools/cli/src
      tests/
    plugin-postgres/                          # @levelzero/plugin-postgres
    plugin-prisma/                            # @levelzero/plugin-prisma
    plugin-hono/                              # @levelzero/plugin-hono
    plugin-typed-client/                      # @levelzero/plugin-typed-client
    plugin-better-auth/                       # @levelzero/plugin-better-auth
    plugin-shadcn/                            # @levelzero/plugin-shadcn
    plugin-next/                              # @levelzero/plugin-next
    plugin-vitest/                            # @levelzero/plugin-vitest
    plugin-playwright/                        # @levelzero/plugin-playwright
    plugin-portless/                          # @levelzero/plugin-portless
    template-v0-stack/                        # @levelzero/template-v0-stack
    create-stack-v0/                          # @levelzero/create-stack-v0
  apps/
    (none yet)
  docs/
    EXTENSION.md                              # rewritten for plugin model
    plugin-author-guide.md                    # new
```

Changesets does independent semver per package. `levelzero release` is `changeset version && changeset publish` (with the standard tooling).

---

## What lives where after the split

### `@levelzero/core` keeps
- Service runner (just OwnedService now)
- StackRegistry + withLock + worktree key derivation
- AdapterRegistry + slot definitions + plugin loader
- CommandRegistry + dispatcher + format/output
- RuleRegistry, GeneratorRegistry, SkillsIndexer
- Compose orchestrator (emits + runs compose files)
- Port allocator
- Plugin protocol + loader

**Commands kept in core** (truly framework-level):
- `dev`, `stop`, `reset`
- `stacks.current/list/prune/stop-all`
- `logs`
- `doctor`
- `impact`, `coverage`, `check`
- `screenshot`, `visual.diff`
- `test`
- `gen` (LEV-124)
- `adapter.list/swap`
- `skills.index`
- `urls`
- New: `compose` passthrough (e.g., `levelzero compose ps` → forwards to `docker compose -p levelzero-<key> ps`)

### Plugin packages take ownership of
| Plugin | Adapters | Commands | Services |
|---|---|---|---|
| `plugin-postgres` | — | — | compose service `postgres` |
| `plugin-prisma` | `orm/prisma` | `db.migrate`, `db.migration.new`, `db.seed`, `db.inspect`, `db.reset` (LEV-123) | — |
| `plugin-hono` | `backend/hono` | — | — (api owned service contributed by template) |
| `plugin-typed-client` | `frontend/typed-client` | — | — |
| `plugin-better-auth` | `auth/better-auth` | `curl` | — |
| `plugin-shadcn` | `ui/shadcn` | `ui.add`, `ui.list` | — |
| `plugin-next` | — | — | — (web owned service contributed by template) |
| `plugin-vitest` | `test-runner/vitest` | — | — |
| `plugin-playwright` | `browser/playwright`, `test-runner/playwright` | — | — |
| `plugin-portless` | `portless/portless`, `portless/noop` | — | — |

`@levelzero/template-v0-stack` ships the scaffolded files plus the generated `levelzero.config.ts` that imports the right plugin set. `@levelzero/create-stack-v0` is the `npx` scaffolder wrapper.

---

## Task list (7 tiers, ~45 tickets)

### Tier 1 — Plugin contract (core)
- 14.1 Define `Plugin`, `PluginAPI`, `PluginContext` types
- 14.2 Plugin loader: NPM specifier + local path resolution
- 14.3 Boot sequence: load config → resolve plugins → call register in order → dispatch
- 14.4 Extend `LevelzeroConfig` schema with `plugins: Plugin[]`
- 14.5 Replace inline `bin.ts` registrations with plugin-loaded equivalents (transitional: keep both during cutover)

### Tier 2 — Docker Compose orchestrator
- 14.6 Define `ComposeServiceDef`, `ComposeVolumeDef`, `ComposeNetworkDef` types
- 14.7 Compose file emitter: collect contributions → write `.levelzero/<key>/docker-compose.yml`
- 14.8 Compose runner: spawn `docker compose -p levelzero-<key> up -d`, parse output, surface healthcheck status
- 14.9 Update `dev`/`stop`/`reset` to use compose runner
- 14.10 Delete `tools/cli/src/docker/` (runner, naming, exec, wait-healthy) — replaced by compose
- 14.11 Add `doctor` check for `docker compose` availability + version
- 14.12 `compose` passthrough command (`levelzero compose <subcommand>`)

### Tier 3 — Workspace restructure (Turborepo + changesets)
- 14.13 Init root workspace `package.json` with `workspaces: ["packages/*"]`
- 14.14 Add `turbo.json` with `build`/`test`/`typecheck` pipelines
- 14.15 Configure changesets (`@changesets/cli`, `.changeset/config.json`, independent versions)
- 14.16 Move `tools/cli/` → `packages/core/` (preserve git history via `git mv`)
- 14.17 Per-package `tsconfig.json` (extends a root `tsconfig.base.json`)
- 14.18 Per-package `vitest.config.ts`
- 14.19 Update CI / scripts / docs to reference the new layout
- 14.20 (Discovery) decide on bundling strategy: tsup vs. raw tsc vs. unbuilt TS published

### Tier 4 — Pilot plugin extraction
- 14.21 Extract `@levelzero/plugin-portless` (smallest scope: 2 adapters, no commands, no services) as the proof-of-concept
- 14.22 Update test fixtures to load `@levelzero/plugin-portless` via the plugin loader
- 14.23 Verify a project using `levelzero.config.ts` with only the portless plugin can run end-to-end

### Tier 5 — Migrate stack-coupled plugins (parallel-safe once Tier 4 lands)
- 14.24 `@levelzero/plugin-postgres` — pg service as compose contribution
- 14.25 `@levelzero/plugin-prisma` — ORMAdapter + db.* commands (+ LEV-123 db.reset if landed)
- 14.26 `@levelzero/plugin-hono` — BackendAdapter
- 14.27 `@levelzero/plugin-typed-client` — FrontendAdapter
- 14.28 `@levelzero/plugin-better-auth` — AuthAdapter + curl command (+ LEV-122 Prisma backing)
- 14.29 `@levelzero/plugin-shadcn` — UIAdapter + ui.* commands
- 14.30 `@levelzero/plugin-next` — Next dev runner contributions
- 14.31 `@levelzero/plugin-vitest` — TestRunnerAdapter
- 14.32 `@levelzero/plugin-playwright` — BrowserAdapter + playwright-test TestRunnerAdapter

### Tier 6 — Template + create-stack-v0
- 14.33 Move `tools/cli/templates/v0-stack/` → `packages/template-v0-stack/`
- 14.34 Generated `levelzero.config.ts` declares `plugins: [postgres, prisma, hono, ...]` explicitly
- 14.35 New `packages/create-stack-v0/` — `npx @levelzero/create-stack-v0 <name>` scaffolder
- 14.36 Update `levelzero init` (in core) to thin wrapper that defers to the template's `npx` entry, OR retire `levelzero init` in core in favor of `npx @levelzero/create-stack-v0` being the canonical entry — design call

### Tier 7 — Documentation + cutover
- 14.37 Rewrite `docs/EXTENSION.md` (LEV-113) around the plugin model
- 14.38 New `docs/plugin-author-guide.md` — walkthrough of writing a plugin, end-to-end
- 14.39 New core skill: `.levelzero/skills/reference/writing-plugins.md` shipped in `@levelzero/core`'s contributed skills
- 14.40 Example plugin: tiny Redis plugin (compose service + adapter slot + skills) committed as `examples/plugin-redis/`
- 14.41 Cut the seam — delete all transitional inline registrations from `packages/core/src/bin.ts`; bin becomes minimal (load config → resolve plugins → dispatch)
- 14.42 Final smoke test: scaffold a v0 project, swap a plugin, register a local plugin, verify everything works
- 14.43 First multi-package release via changesets (`changeset version && changeset publish` against private/internal registry first, then npm when ready)

---

## New deps

- `@changesets/cli` (dev) at workspace root
- `turbo` (dev) at workspace root
- Compose v2 (host machine requirement; not a package dep). Add to `doctor`.

No new runtime deps for the framework itself; plugins each carry their own.

---

## Out of scope

- Plugin marketplace / discovery UI
- Per-plugin permission model (any plugin can register any command for now)
- Hot reload of plugins at runtime — config changes require a restart
- npm publishing automation beyond changesets' built-in flow
- Versioning the `Plugin` interface itself — plugin loader assumes v1 contract; we'll add a `protocolVersion` field if/when we need to evolve it

---

## Verification

- `npx @levelzero/create-stack-v0 demo && cd demo && bun install && levelzero dev` brings up postgres + api + web via docker compose, with all expected ports and containers.
- `docker compose -p levelzero-<key> ps` from anywhere shows the running stack — operator tooling works transparently.
- Adding a project-local plugin (e.g., `./local-plugins/redis.ts`) and re-running `levelzero dev` brings up Redis alongside the rest.
- `levelzero adapter list` reflects only the adapters from active plugins (no phantom slots).
- `levelzero --help` (when LEV-117 lands) lists exactly the commands the active plugins contributed.
- `changeset version` → produces per-package version bumps; `changeset publish` produces npm-ready packages.
- Two worktrees can each run `levelzero dev` simultaneously with no compose-project collision (verified at the worktree-key level).
