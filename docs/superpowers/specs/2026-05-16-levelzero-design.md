# lich — Design Spec

**Date:** 2026-05-16
**Status:** Draft (v0 design)

## Thesis

**Raise the floor on AI-generated code so review stops being the bottleneck.**

Agents today open PRs that pass unit tests and lint and still ship broken behavior. The reason isn't model capability — it's that the harness around the model doesn't give it the tools to validate its own work against the real system. Every team that takes AI-assisted development seriously ends up rebuilding the same vertical harness: local stack orchestration, state inspection, deterministic seeds, log aggregation, integration runners, impact analysis, screenshot capture. None of it is hard; nobody ships it as a coherent thing; everybody does it badly in isolation.

**lich is that harness, packaged as a framework.** An opinionated OSS stack with a CLI that is the agent's primary interface to the system, a validation loop that runs end-to-end locally, and skills that teach an agent how to ship a change confidently against this specific stack.

The goal: an agent's PR against a lich project comes pre-validated to a bar that lets the human review it with a glance instead of a line-by-line read.

## Design principles

These are load-bearing and shape every decision below.

1. **The CLI is for agents, not humans.** Humans live in their agent harness of choice (Claude Code, Codex, Conductor). The CLI is what the agent invokes. Every command is structured-output-by-default, fully flag-driveable, has no interactive prompts (except `init`), and ships machine-readable help. `--pretty` exists for occasional human eyeballing; it is the exception.
2. **Workflow as shell, knowledge as library.** The framework ships one high-level workflow skill (`change`) that knows the *shape* of any change. It never hardcodes recipes for specific kinds of changes ("add a route", "add a migration") — those rot. Instead, `change` shells out to reference skills that document each tool in the stack. Detail lives in references the agent pulls on demand.
3. **CLI ships primitives + checks; skills ship policy + workflows.** The CLI is mechanical and deterministic: it can tell you what depends on a file, what coverage looks like, whether a route has tests. It never tells you what *should* be tested or how to structure your work. Opinions live in skills and are configurable per project.
4. **Inspection is first-class, not a debugging afterthought.** Every part of the running stack — DB state, routes, sessions, jobs, logs — has a `lich inspect` or equivalent command that returns structured data. Agents call these *during* implementation to verify assumptions, not just when things break.
5. **Adapters from day one.** Every swappable component (ORM, frontend framework, package manager, auth, eventually browser driver) sits behind a capability-shaped adapter interface. v0 ships one implementation per slot. Future implementations fill the interface; they do not retrofit it.
6. **Local first, deploy parity later.** v0 runs the entire stack on the developer's machine in seconds via Docker + the CLI. The deploy story (v2) is "what you validated locally is what runs in prod" — meaning the local design must not preclude remote parity. No magic that only works locally.
7. **Worktree-isolated by default.** Multiple stacks run fully independently and in parallel — separate ports, separate containers, separate databases — keyed off the worktree's absolute path. Every CLI command auto-detects which stack it's operating against from `cwd`. The agent never reasons about ports, container names, or which copy of Postgres is which. This is what makes parallel agent-driven branches actually workable.
8. **Open by extension.** Every tool-specific piece of the system (services, adapters, `check` rules, skills) sits behind a contract. Built-ins use the same contracts as user extensions — no special-casing. Adding Redis, a queue worker, a custom check, or a project-specific skill is the same code path as anything that ships in the box. v0 implements the contracts; the extension surface is exercised but not heavily documented until v1.

## Validation checklist

This is the ground truth the framework optimizes for. A lich PR is considered ready for one-glance review when all of these are green:

1. **E2E tests on core workflows pass.**
2. **Integration tests on core workflows pass.**
3. **If the change touches DB schema:** migrations apply cleanly on a fresh DB, and the full test suite passes against the migrated schema.
4. **UI changes:** screenshots of every touched route are attached to the PR description. Visual regression diffs flag unintended changes to untouched routes.
5. **Blast-radius coverage:** the full test suite is the catch-all CI gate. During authoring, the agent has used `lich impact` to identify downstream-affected code and added regression tests where appropriate.

The full suite always runs in CI as the safety net. The framework's job is to make items 1–4 cheap, deterministic, and agent-driveable, and to make item 5 *inspectable* during authoring so the agent can write the right tests.

## Stack (v0)

| Slot | Choice | Notes |
|---|---|---|
| Database | Postgres | Universal substrate; not a real decision. |
| ORM | Prisma | User preference; behind an adapter. |
| Backend framework | Hono | Runtime-agnostic, typed client generation, separate deployable. |
| Auth | Better Auth | Self-hosted library; plays nicely with own DB. |
| Frontend | Next.js (App Router, frontend only) | Deepest agent training data wins for v0. |
| Styling | Tailwind CSS | Required by shadcn; the default with Next anyway. |
| Component library | [shadcn/ui](https://ui.shadcn.com) | Components copied into the repo (not a black-box dep) — fits "everything inspectable." Excellent agent training data. Radix-based a11y. |
| Package manager | Bun | Default; behind an adapter. |
| Monorepo | Turborepo | PM-agnostic orchestration. |
| Unit + integration tests | Vitest | Universal. |
| E2E tests | Playwright | v0 only; replaced by a custom agent-first browser driver in v2. |
| Container orchestration | Docker Compose | Local infra (Postgres, anything else unowned). |
| Owned-process orchestration | [concurrently](https://github.com/open-cli-tools/concurrently) | Single multiplexed `lich up` invocation spawns every owned service with per-service log prefixing and restart-on-fail. Adding an owned service = one more concurrently target. |
| Hot reload (backend) | `bun --hot run` | Native Bun HMR for Hono; no nodemon/tsx-watch. |
| Hot reload (frontend) | Next.js dev server | Built-in HMR. |
| Lint + format | [Biome](https://biomejs.dev) | One tool for both, zero-config friendly, fast. Replaces ESLint + Prettier. |
| Web URL ergonomics | [portless](https://github.com/vercel-labs/portless) (web only) | Named `https://<branch>.myapp.localhost` for the frontend so humans can tell which stack they're viewing. Api stays on a raw port. |

### Why a separate Hono backend (not Next route handlers / Server Actions)

This is the single most opinionated stack decision and the rationale matters:

1. **Frontend becomes swappable.** With backend logic in Next, swapping frontends means rewriting the backend. With a separate Hono service, Next is just a typed client of the API; the adapter pitch holds.
2. **Deployable independently.** Backend scales separately and survives any frontend rewrite. Required for the v2 deploy story.
3. **One API surface.** Server Actions and Route Handlers are parallel conventions that get muddled. Hono is one surface; agents reason about it cleanly; the validation harness has one thing to introspect.
4. **Integration tests run without Next.** Spin up Hono + Postgres + Better Auth, hammer the API directly. Faster, cleaner, the integration tier becomes the primary validation layer rather than a flaky afterthought.
5. **Typed client generation.** Hono's `hc` gives end-to-end types over plain HTTP. Same DX as tRPC/Server Actions, but the server doesn't care who calls it. This is what makes the frontend *actually* swappable.
6. **Background work has a home.** Queues, jobs, websockets belong in the backend service, not bolted onto Next.

The cost is two processes locally. The CLI hides this — `lich up` brings up everything with one command.

## Monorepo layout

```
apps/
  web/                # Next.js frontend (frontend only — no API routes)
  api/                # Hono backend
packages/
  db/                 # Prisma schema, migrations, generated client
  auth/               # Better Auth config (consumed by api + web)
  api-client/         # Generated typed Hono client (consumed by web, etc.)
  config/             # Shared tsconfig, eslint, etc.
tests/
  integration/        # Vitest — hits api + db + auth, no frontend
  e2e/                # Playwright — full stack
  # unit tests live alongside source in each package/app
tools/
  cli/                # The lich CLI itself
  skills/             # Shipped agent skills (workflow + reference)
docker-compose.yml
lich.config.ts   # Adapter selections + project config
CLAUDE.md             # Agent entrypoint — lists skills, surfaces conventions
```

**Conventions worth being deliberate about:**

- `packages/db` is its own package so schema is decoupled from the API. Background jobs and scripts depend on `@lich/db` without depending on Hono.
- `packages/api-client` is generated from the Hono backend's types. The frontend imports types from here, never from `apps/api` directly. This package is the contract that keeps Next swappable.
- `tests/integration` and `tests/e2e` are top-level because they cross package boundaries. Putting them inside `apps/api` would lie about what they cover.

## CLI surface

All commands support `--json` (default for most), `--pretty` for human read, and structured `--help`. Noun-verb grammar.

All commands operate against the **auto-detected stack** for the current `cwd` (see "Multi-worktree support" below). The agent never passes ports, container names, or stack identifiers — those are resolved transparently.

### Lifecycle

- `lich init` — scaffold a project; prompts (or takes flags) for adapter choices; writes `lich.config.ts`.
- `lich up` — bring up Postgres + api + web for *this* worktree's stack; allocate/reuse the stack's port block; tee structured logs to `.lich/logs/`.
- `lich down` — clean teardown of this worktree's stack.
- `lich reset` — nuke this stack's DB, re-migrate, re-seed. The "known starting point" command.
- `lich doctor` — diagnose local environment. Used by agents for self-diagnosis.

### Stacks (multi-worktree)

- `lich stacks list` — list every running lich stack across all worktrees on this machine; for each: worktree path, allocated ports, container names, uptime.
- `lich stacks current` — show the stack the CLI would target from `cwd` (path, ports, container names). Useful for diagnosis; agents rarely need it because commands auto-target.
- `lich nuke` — tear down every running lich stack regardless of `cwd`. Escape hatch for "clean slate everywhere."
- `lich stacks stop <key|path>` — tear down a specific stack by worktree key or path.
- `lich stacks prune` — remove registry entries and orphaned containers for worktrees that no longer exist on disk.

### Database

- `lich db migrate` — apply pending migrations.
- `lich db migration new <name>` — generate a new migration.
- `lich db seed` — run seed scripts.
- `lich db inspect [--schema | --rows <table>]` — JSON dump of schema or table contents.

### Validation

- `lich test [unit|integration|e2e]` — run a tier or all.
- `lich impact <path|symbol>` — JSON list of dependents. Agent calls this while authoring.
- `lich coverage [--threshold <n>]` — unified coverage across all tiers; surfaces uncovered routes/files.
- `lich check` — run framework-level conventions (route coverage, schema/migration consistency, type-client freshness). Pluggable rules.
- `lich screenshot <route> [--auth <user>]` — capture a screen; used for PR attachments and visual regression baselines.
- `lich visual diff` — run visual regression; emit diffs.
- `lich inspect [routes|sessions|jobs|state]` — runtime introspection of the running stack.

### Logs

- `lich logs [--service <name,...>] [--grep <pattern>] [--since <time>] [--level <level>] [--tail <n>] [--follow]` — unified query across owned services and Docker-managed infra for the auto-detected stack. Structured JSON output by default. Critical to the validation loop: when a test fails, the agent grabs logs by time window without per-test wiring.

### Request

- `lich curl <path> [--method <verb>] [--data <json>] [--as <user>]` — hit a backend endpoint on the auto-detected stack. Resolves the correct port, handles auth (creates/reuses a session for `--as <user>`), pretty-prints JSON responses. Replaces hand-rolled `curl localhost:$RANDOM_PORT/api/...` and the auth-cookie dance. The agent uses this for ad-hoc probing during implementation and debugging.

### Codegen

- `lich gen client` — regenerate `packages/api-client` from Hono types.
- `lich gen types` — anything else type-derived.

### UI

- `lich ui add <component>` — add a shadcn component to `apps/web` via the configured `UIAdapter`. Thin wrapper that resolves the right working dir, runs the underlying tool, and reports what files landed.
- `lich ui list` — list installed shadcn components (parsed from `components.json` / the repo).

### Meta

- `lich adapter list` / `lich adapter swap <slot> <impl>` — see or change adapter choices.

## Multi-worktree support

Agent-driven development means many branches in flight in parallel. Today, every framework assumes one stack per machine — port 5432, container `myapp_postgres_1`, seed data shared across whoever happens to be running. Two agents on two branches collide instantly. lich treats parallel stacks as the **default**, not an advanced configuration.

### Web URL ergonomics: portless (web only)

The web frontend runs through [portless](https://github.com/vercel-labs/portless) so the browser tab shows a human-readable URL per worktree: `https://feature-x.myapp.localhost`. This is the *only* place humans interact with stack URLs (agents go through `lich curl`), and the URL is the only visual cue distinguishing one worktree's UI from another's. Worth the small dependency.

The api **does not** go through portless — nothing ever visits it in a browser. It stays on a raw allocated port. To avoid CORS / mixed-content issues from web → api calls, the Next.js dev server is configured with rewrites: `/api/*` on the web origin proxies to `http://localhost:<api-port>/*`. This is dev-only and doesn't affect prod, where the api is an independent deployable as designed.

What this means for the rest of the system:

- Registry still owns Postgres + api port allocation as before.
- `lich curl` and tests target the raw api port (unchanged).
- Portless owns only the web-side URL. Its state lives in its own dir; we don't try to mirror it.
- Failure mode: if portless is misconfigured or its proxy isn't up, `doctor` surfaces the error and offers the fallback `http://localhost:<web-port>` URL from the registry so the human is never blocked.

### Worktree key

Every stack is identified by a **worktree key**: a stable identifier derived from the absolute, canonical path of the worktree root (the directory containing `lich.config.ts`). Using the full path — not just the directory name — avoids collisions when two worktrees share a basename (`feature-x/` in two different parent dirs).

The key is recorded in a machine-local registry at `~/.lich/registry.json` — the single source of truth for what's running where:

```jsonc
{
  "stacks": {
    "<sha256(absolute_path)[:12]>": {
      "path": "/Users/ryan/code/myapp-worktrees/feature-x",
      "branch": "feature-x",
      "ports": {
        "postgres": 54123,
        "api": 54124,
        "web": 54125
      },
      "urls": {
        "api": "http://localhost:54124",
        "web": "http://localhost:54125",
        "webPretty": "https://feature-x.myapp.localhost"
      },
      "containers": ["lich-a3f8c1-postgres"],
      "network": "lich-a3f8c1",
      "logDir": ".lich/logs",
      "createdAt": "..."
    }
  }
}
```

### Port allocation

Each stack reserves a contiguous block of ports from a lich-owned range (proposed: `54000–54999`, 10 ports per stack). Allocation rules:

- On first `lich up` for a worktree, allocate the next free block and persist it.
- Subsequent `dev` invocations reuse the same allocation — ports are stable per worktree across restarts.
- If a previously allocated port is occupied by something outside lich, `doctor` surfaces a clear error rather than silently reassigning.
- `stacks prune` reclaims allocations from worktrees that no longer exist on disk.

Agents never reference ports. They use `lich curl /api/foo` for backend calls and `lich db inspect` for DB inspection — the CLI resolves the right port from the registry. The api process and tests receive ports via injected environment variables (`DATABASE_URL`, `API_URL`, `AUTH_URL`).

For humans peeking in a browser, `lich stacks current` returns the worktree's URLs.

### Container and network isolation

Every Docker resource is namespaced by the worktree key:

- Containers: `lich-<key>-<service>` (e.g. `lich-a3f8c1-postgres`).
- Networks: `lich-<key>`.
- Volumes: `lich-<key>-<service>-data`.

`nuke` and `stacks prune` work off the `lich-` prefix.

### Auto-detection

Every CLI command walks up from `cwd` until it finds a `lich.config.ts`. That directory's absolute path is the worktree key. The CLI loads the registry entry for that key and routes the command to the correct stack: `lich test` runs against this stack's ports, `lich logs` reads this stack's log directory, `lich curl` hits this stack's API. The agent never specifies the stack explicitly.

If no `lich.config.ts` is found, the command errors with an actionable message ("not inside a lich project; run `lich init` or `cd` into one").

### Tests target the correct stack

Vitest and Playwright runners are spawned with the auto-detected stack's connection details injected as environment variables:
- `DATABASE_URL` — `postgres://...localhost:<allocated-postgres-port>/...`
- `API_URL` — `http://localhost:<allocated-api-port>`
- `AUTH_URL` — same root as `API_URL` or its own port.

Tests never reference hardcoded ports — they consume the env vars provided by the runner. Tests on worktree A run against stack A, tests on worktree B run against stack B, concurrently and without collision.

### Out-of-scope for v0 (worktree-specific)

- Cross-stack data sharing (e.g. "snapshot stack A's DB into stack B"). Each stack is fully independent.
- Remote stacks (running someone else's worktree's stack on your machine for collaboration). Local only.

## Process orchestration & hot reload

`lich up` brings up everything for the current worktree in one command. Two layers of orchestration:

1. **Docker-managed services** (Postgres, Redis-if-added, anything else `kind: 'docker'`): brought up via a worktree-namespaced `docker compose up -d`. Containers, networks, and volumes are prefixed by the worktree key (see §"Multi-worktree support").
2. **Owned services** (api, web, workers, anything `kind: 'owned'`): spawned as one `concurrently` invocation, all in the foreground of the `dev` process. Output is multiplexed with per-service prefix + color and tee'd to `.lich/logs/<service>.jsonl` so `lich logs` can query later.

### Owned-service contract under concurrently

Each owned service contributes a row to the concurrently invocation. The Service interface (`kind: 'owned'`) exposes the four fields concurrently needs plus the env contributions other services depend on:

```ts
interface OwnedService extends Service {
  kind: 'owned';
  cwd: string;                                    // relative to project root
  command: string;                                // shell-quoted, hot-reload-aware
  envContributions: (ports: PortMap) => Record<string, string>;
  dependsOn?: string[];                           // names of other services
}
```

The dev orchestrator topologically sorts services by `dependsOn`, brings up docker services first, then spawns `concurrently --kill-others-on-fail --names <a>,<b>,... '<cmd-a>' '<cmd-b>' ...` with the right env per process.

### Hot reload as a default

Every owned service ships with hot reload in dev. The convention is that the service's `command` field uses a watcher-aware invocation:

- **Hono backend**: `bun --hot run src/index.ts`. Native Bun HMR — no `tsx watch`, no `nodemon`.
- **Next.js frontend**: `next dev` (HMR built in).
- **Project-added services**: declare their own watcher (e.g. `bun --hot`, `tsx watch`, `cargo watch`, `watchfiles`).

The CLI does not enforce a specific watcher; it executes whatever command the service declares. The convention exists so the default experience is: edit a file, see the change without restarting `lich up`. The scaffolder skill nudges authors toward this when they add a new owned service.

### Adding a new owned service

This is the extensibility path for owned services (Docker-only services are still declared in `services` per §"Extensibility"). In `lich.config.ts`:

```ts
services: [
  // ...built-ins
  {
    name: 'worker',
    kind: 'owned',
    cwd: 'apps/worker',
    command: 'bun --hot run src/index.ts',
    dependsOn: ['postgres', 'redis'],
    envContributions: (ports) => ({
      DATABASE_URL: `postgres://localhost:${ports.postgres}/app`,
      REDIS_URL:    `redis://localhost:${ports.redis}`,
    }),
  },
]
```

`lich up` picks it up automatically: it shows up in the concurrently output, its logs tee to `.lich/logs/worker.jsonl`, `lich logs --service worker` queries them, `lich down` kills it cleanly. No CLI code change required.

## Test patterns

- **Unit:** Vitest, colocated with source. Pure, no DB, no network. Default skill biases the agent toward writing these for non-trivial logic.
- **Integration:** Vitest, live at `tests/integration/`. Hits real Postgres, real Better Auth, real Hono. Default isolation strategy: **transactional rollback per test** (fast); opt-out to fresh-DB per test for transaction-using code via an explicit annotation. Auth exercised through real Better Auth APIs by default; a test-only session helper exists for tests where auth isn't the subject.
- **E2E:** Playwright (v0), `tests/e2e/`, full stack. Same clean-state guarantee as integration.

The framework does not prescribe *what* to test — that lives in skills and is configurable. The CLI provides `coverage` and `check` so the agent can see what isn't tested and act on it.

## Skills

Two kinds, shipped under `tools/skills/`.

### Workflow skills (verbs — kept lean)

- **`change`** — the entrypoint for any change. High-level workflow: understand intent → check impact → plan → implement → validate at the appropriate tier → PR. At each step, points to reference skills for whatever tools the change touches. The *only* skill an agent always loads.
- **`debug`** — invoked when something is broken. Workflow: reproduce → logs → state inspection → hypothesis → fix. Different framing from change, separate skill.
- **`onboard`** — first-time setup when an agent lands in a lich project. Reads config, runs doctor, surveys the skill library.

### Reference skills (nouns — the lookup library)

One per stack tool, stack-specific (not generic vendor docs): how *this stack* uses the tool, conventions, gotchas, common patterns.

- `prisma`, `hono`, `next`, `tailwind`, `shadcn`, `better-auth`, `vitest`, `playwright`, `turbo`, `biome`, `concurrently`, `lich-cli`.

### CLAUDE.md

The agent entrypoint. Indexes every skill with a one-liner, surfaces load-bearing project facts (stack choices, conventions, config location). Read on session start.

## Adapter interfaces

v0 ships one implementation per slot, but the interface is the seam. Capability-shaped, not tool-shaped — methods describe *what* the adapter does, not which tool does it.

Sketches (TypeScript, illustrative):

```ts
interface ORMAdapter {
  applyMigrations(): Promise<MigrationResult>;
  newMigration(name: string): Promise<MigrationFile>;
  inspectSchema(): Promise<SchemaDescription>;
  inspectTable(name: string): Promise<Row[]>;
  resetDatabase(): Promise<void>;
  generateClient(): Promise<void>;
}

interface AuthAdapter {
  createUser(input: CreateUserInput): Promise<User>;
  signSession(userId: string): Promise<SessionToken>;
  inspectSession(token: string): Promise<SessionInfo>;
}

interface FrontendAdapter {
  devCommand(): SpawnSpec;
  buildCommand(): SpawnSpec;
  routeManifest(): Promise<RouteList>;
}

interface PackageManagerAdapter {
  install(): Promise<void>;
  add(packages: string[], opts: AddOpts): Promise<void>;
  workspacesConfig(): WorkspacesConfig;
}

interface UIAdapter {
  add(component: string, opts: AddComponentOpts): Promise<AddComponentResult>;
  list(): Promise<InstalledComponent[]>;
}

interface BrowserAdapter {
  screenshot(route: string, opts: ScreenshotOpts): Promise<Image>;
  visualDiff(baseline: Image, current: Image): Promise<DiffResult>;
  // SDK-side methods used by e2e tests
  drive(): BrowserSession;
}
```

The CLI never imports a specific tool. It loads adapters via `lich.config.ts` and dispatches.

## Extensibility

Real projects outgrow the default stack. They add Redis for caching, a queue worker, Meilisearch for search, Mailpit for dev email, a Python service, ClickHouse for analytics. lich is designed so adding these is the same code path the built-in services already use — not a plugin system bolted on later.

### The Service contract

Every running thing in a lich stack — Postgres, api, web, and anything a project adds — is a `Service` satisfying the same interface:

```ts
interface Service {
  name: string;                       // unique within stack, used in logs and CLI
  kind: 'docker' | 'owned' | 'external';
  portNames: string[];                // lich allocates actual numbers
  start(ctx: StackContext): Promise<RunningHandle>;
  stop(handle: RunningHandle): Promise<void>;
  envContributions(ports: PortMap): Record<string, string>;
  healthCheck(ctx: StackContext): Promise<HealthStatus>;
  logSource(ctx: StackContext): LogSource;
  identity(ctx: StackContext): ServiceIdentity;  // container names, PIDs, etc.
}
```

The registry, port allocator, `stacks list`, `nuke`, `logs`, and `doctor` iterate the service list. **They do not hardcode "postgres + api + web."** The built-in services implement `Service`; project-defined services implement the same interface and slot in seamlessly.

### Declaring extra services

In `lich.config.ts`:

```ts
export default defineConfig({
  // ...adapters
  services: [
    {
      name: 'redis',
      kind: 'docker',
      image: 'redis:7-alpine',
      portNames: ['redis'],
      envContributions: (ports) => ({ REDIS_URL: `redis://localhost:${ports.redis}` })
    },
    {
      name: 'worker',
      kind: 'owned',
      cwd: 'apps/worker',
      command: 'bun run start',
      dependsOn: ['redis', 'postgres'],
    }
  ]
});
```

`dependsOn` determines startup order. `envContributions` from upstream services flow into the env of downstream ones.

### CLI plugin surface

Beyond services, the CLI itself is extensible:

- **Custom commands.** Project plugins can register additional `lich <verb>` commands.
- **Custom `check` rules.** Project plugins can add conformance rules to `lich check` (e.g. "every Redis-using route has a cache invalidation test").
- **Custom adapters.** The adapter slot system already supports this — implementations live in or beside the project.

The built-in CLI command set is registered through the same plugin interface — there is no "core vs. plugin" split.

### Skills

Skills are a directory, not a hardcoded list. CLAUDE.md is regenerated by a CLI command (`lich skills index`) by scanning `tools/skills/` and the user's plugin paths. Project-shipped skills appear in the agent's index next to built-in ones, with no special treatment.

### v0 scope

v0 implements the Service contract for the built-ins and uses it internally — meaning the architecture is shaped by extensibility from day one, even if the user-facing "here's how to add a service" docs are thin. Heavy documentation, ergonomic helpers (`defineService`, scaffolders for common service types), and a plugin discovery mechanism land in v1. The point of doing this now: if v0 hardcodes Postgres/api/web specifically, extension is a rewrite. If it doesn't, extension is mostly docs.

## `init` and scaffolding (v0)

`lich init` is template-based: one template per adapter combination. v0 ships exactly one combination (the v0 stack), so `init` is a single template rendered into the target directory. Future combinations add templates. The framework intentionally avoids generators/codemods for converting between adapter combinations in v0 — that's a v2+ problem.

`init` flags:

- `--name <project-name>`
- `--pm <bun|pnpm|npm>` (only `bun` works in v0)
- `--orm <prisma|drizzle>` (only `prisma` works in v0)
- ...etc.

Non-interactive use is fully supported; an interactive prompt is the default for human-driven `init`.

## Out of scope for v0 (explicit)

Named so future-self doesn't accidentally bake assumptions that preclude them:

- **Deploy platform.** v2. Local design must allow remote parity (single backend artifact, Docker-compatible infra).
- **Custom browser driver.** Playwright wrapped behind `BrowserAdapter`; replace later without touching consumers.
- **Review bots.** GitHub Actions running `lich check` and skill-driven conformance review. Ecosystem follow-on.
- **Adapter implementations beyond the v0 stack.** Drizzle, TanStack Start, pnpm, etc. — interfaces designed for them, implementations land later.
- **Generators/codemods for swapping adapters in an existing project.** v2+.

## Open questions

- Naming and packaging of the published artifact (`@lich/cli`? `lich` standalone binary?).
- How `lich.config.ts` versioning interacts with CLI version skew across long-lived projects.
- The exact shape of structured `--help` output (likely OpenAPI-ish or a custom schema; needs prototyping).
- Whether `lich impact` is LSP-backed, ts-morph-backed, or a thin wrapper around an existing tool — decision deferred to implementation.
