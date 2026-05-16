# levelzero — Design Spec

**Date:** 2026-05-16
**Status:** Draft (v0 design)

## Thesis

**Raise the floor on AI-generated code so review stops being the bottleneck.**

Agents today open PRs that pass unit tests and lint and still ship broken behavior. The reason isn't model capability — it's that the harness around the model doesn't give it the tools to validate its own work against the real system. Every team that takes AI-assisted development seriously ends up rebuilding the same vertical harness: local stack orchestration, state inspection, deterministic seeds, log aggregation, integration runners, impact analysis, screenshot capture. None of it is hard; nobody ships it as a coherent thing; everybody does it badly in isolation.

**levelzero is that harness, packaged as a framework.** An opinionated OSS stack with a CLI that is the agent's primary interface to the system, a validation loop that runs end-to-end locally, and skills that teach an agent how to ship a change confidently against this specific stack.

The goal: an agent's PR against a levelzero project comes pre-validated to a bar that lets the human review it with a glance instead of a line-by-line read.

## Design principles

These are load-bearing and shape every decision below.

1. **The CLI is for agents, not humans.** Humans live in their agent harness of choice (Claude Code, Codex, Conductor). The CLI is what the agent invokes. Every command is structured-output-by-default, fully flag-driveable, has no interactive prompts (except `init`), and ships machine-readable help. `--pretty` exists for occasional human eyeballing; it is the exception.
2. **Workflow as shell, knowledge as library.** The framework ships one high-level workflow skill (`change`) that knows the *shape* of any change. It never hardcodes recipes for specific kinds of changes ("add a route", "add a migration") — those rot. Instead, `change` shells out to reference skills that document each tool in the stack. Detail lives in references the agent pulls on demand.
3. **CLI ships primitives + checks; skills ship policy + workflows.** The CLI is mechanical and deterministic: it can tell you what depends on a file, what coverage looks like, whether a route has tests. It never tells you what *should* be tested or how to structure your work. Opinions live in skills and are configurable per project.
4. **Inspection is first-class, not a debugging afterthought.** Every part of the running stack — DB state, routes, sessions, jobs, logs — has a `levelzero inspect` or equivalent command that returns structured data. Agents call these *during* implementation to verify assumptions, not just when things break.
5. **Adapters from day one.** Every swappable component (ORM, frontend framework, package manager, auth, eventually browser driver) sits behind a capability-shaped adapter interface. v0 ships one implementation per slot. Future implementations fill the interface; they do not retrofit it.
6. **Local first, deploy parity later.** v0 runs the entire stack on the developer's machine in seconds via Docker + the CLI. The deploy story (v2) is "what you validated locally is what runs in prod" — meaning the local design must not preclude remote parity. No magic that only works locally.
7. **Worktree-isolated by default.** Multiple stacks run fully independently and in parallel — separate ports, separate containers, separate databases — keyed off the worktree's absolute path. Every CLI command auto-detects which stack it's operating against from `cwd`. The agent never reasons about ports, container names, or which copy of Postgres is which. This is what makes parallel agent-driven branches actually workable.

## Validation checklist

This is the ground truth the framework optimizes for. A levelzero PR is considered ready for one-glance review when all of these are green:

1. **E2E tests on core workflows pass.**
2. **Integration tests on core workflows pass.**
3. **If the change touches DB schema:** migrations apply cleanly on a fresh DB, and the full test suite passes against the migrated schema.
4. **UI changes:** screenshots of every touched route are attached to the PR description. Visual regression diffs flag unintended changes to untouched routes.
5. **Blast-radius coverage:** the full test suite is the catch-all CI gate. During authoring, the agent has used `levelzero impact` to identify downstream-affected code and added regression tests where appropriate.

The full suite always runs in CI as the safety net. The framework's job is to make items 1–4 cheap, deterministic, and agent-driveable, and to make item 5 *inspectable* during authoring so the agent can write the right tests.

## Stack (v0)

| Slot | Choice | Notes |
|---|---|---|
| Database | Postgres | Universal substrate; not a real decision. |
| ORM | Prisma | User preference; behind an adapter. |
| Backend framework | Hono | Runtime-agnostic, typed client generation, separate deployable. |
| Auth | Better Auth | Self-hosted library; plays nicely with own DB. |
| Frontend | Next.js (App Router, frontend only) | Deepest agent training data wins for v0. |
| Package manager | Bun | Default; behind an adapter. |
| Monorepo | Turborepo | PM-agnostic orchestration. |
| Unit + integration tests | Vitest | Universal. |
| E2E tests | Playwright | v0 only; replaced by a custom agent-first browser driver in v2. |
| Container orchestration | Docker Compose | Local infra (Postgres, anything else unowned). |
| HTTP ingress / local URLs | [portless](https://github.com/vercel-labs/portless) | Stable named URLs per worktree, automatic HTTPS, no port management. Native git-worktree subdomain support. |

### Why a separate Hono backend (not Next route handlers / Server Actions)

This is the single most opinionated stack decision and the rationale matters:

1. **Frontend becomes swappable.** With backend logic in Next, swapping frontends means rewriting the backend. With a separate Hono service, Next is just a typed client of the API; the adapter pitch holds.
2. **Deployable independently.** Backend scales separately and survives any frontend rewrite. Required for the v2 deploy story.
3. **One API surface.** Server Actions and Route Handlers are parallel conventions that get muddled. Hono is one surface; agents reason about it cleanly; the validation harness has one thing to introspect.
4. **Integration tests run without Next.** Spin up Hono + Postgres + Better Auth, hammer the API directly. Faster, cleaner, the integration tier becomes the primary validation layer rather than a flaky afterthought.
5. **Typed client generation.** Hono's `hc` gives end-to-end types over plain HTTP. Same DX as tRPC/Server Actions, but the server doesn't care who calls it. This is what makes the frontend *actually* swappable.
6. **Background work has a home.** Queues, jobs, websockets belong in the backend service, not bolted onto Next.

The cost is two processes locally. The CLI hides this — `levelzero dev` brings up everything with one command.

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
  cli/                # The levelzero CLI itself
  skills/             # Shipped agent skills (workflow + reference)
docker-compose.yml
levelzero.config.ts   # Adapter selections + project config
CLAUDE.md             # Agent entrypoint — lists skills, surfaces conventions
```

**Conventions worth being deliberate about:**

- `packages/db` is its own package so schema is decoupled from the API. Background jobs and scripts depend on `@levelzero/db` without depending on Hono.
- `packages/api-client` is generated from the Hono backend's types. The frontend imports types from here, never from `apps/api` directly. This package is the contract that keeps Next swappable.
- `tests/integration` and `tests/e2e` are top-level because they cross package boundaries. Putting them inside `apps/api` would lie about what they cover.

## CLI surface

All commands support `--json` (default for most), `--pretty` for human read, and structured `--help`. Noun-verb grammar.

All commands operate against the **auto-detected stack** for the current `cwd` (see "Multi-worktree support" below). The agent never passes ports, container names, or stack identifiers — those are resolved transparently.

### Lifecycle

- `levelzero init` — scaffold a project; prompts (or takes flags) for adapter choices; writes `levelzero.config.ts`.
- `levelzero dev` — bring up Postgres + api + web for *this* worktree's stack; allocate/reuse the stack's port block; tee structured logs to `.levelzero/logs/`.
- `levelzero stop` — clean teardown of this worktree's stack.
- `levelzero reset` — nuke this stack's DB, re-migrate, re-seed. The "known starting point" command.
- `levelzero doctor` — diagnose local environment. Used by agents for self-diagnosis.

### Stacks (multi-worktree)

- `levelzero stacks list` — list every running levelzero stack across all worktrees on this machine; for each: worktree path, allocated ports, container names, uptime.
- `levelzero stacks current` — show the stack the CLI would target from `cwd` (path, ports, container names). Useful for diagnosis; agents rarely need it because commands auto-target.
- `levelzero stacks stop --all` — tear down every running levelzero stack regardless of `cwd`. Escape hatch for "clean slate everywhere."
- `levelzero stacks stop <key|path>` — tear down a specific stack by worktree key or path.
- `levelzero stacks prune` — remove registry entries and orphaned containers for worktrees that no longer exist on disk.

### Database

- `levelzero db migrate` — apply pending migrations.
- `levelzero db migration new <name>` — generate a new migration.
- `levelzero db seed` — run seed scripts.
- `levelzero db inspect [--schema | --rows <table>]` — JSON dump of schema or table contents.

### Validation

- `levelzero test [unit|integration|e2e]` — run a tier or all.
- `levelzero impact <path|symbol>` — JSON list of dependents. Agent calls this while authoring.
- `levelzero coverage [--threshold <n>]` — unified coverage across all tiers; surfaces uncovered routes/files.
- `levelzero check` — run framework-level conventions (route coverage, schema/migration consistency, type-client freshness). Pluggable rules.
- `levelzero screenshot <route> [--auth <user>]` — capture a screen; used for PR attachments and visual regression baselines.
- `levelzero visual diff` — run visual regression; emit diffs.
- `levelzero inspect [routes|sessions|jobs|state]` — runtime introspection of the running stack.

### Logs

- `levelzero logs [--service <name,...>] [--grep <pattern>] [--since <time>] [--level <level>] [--tail <n>] [--follow]` — unified query across owned services and Docker-managed infra for the auto-detected stack. Structured JSON output by default. Critical to the validation loop: when a test fails, the agent grabs logs by time window without per-test wiring.

### Request

- `levelzero curl <path> [--method <verb>] [--data <json>] [--as <user>]` — hit a backend endpoint on the auto-detected stack. Resolves the correct port, handles auth (creates/reuses a session for `--as <user>`), pretty-prints JSON responses. Replaces hand-rolled `curl localhost:$RANDOM_PORT/api/...` and the auth-cookie dance. The agent uses this for ad-hoc probing during implementation and debugging.

### Codegen

- `levelzero gen client` — regenerate `packages/api-client` from Hono types.
- `levelzero gen types` — anything else type-derived.

### Meta

- `levelzero adapter list` / `levelzero adapter swap <slot> <impl>` — see or change adapter choices.

## Multi-worktree support

Agent-driven development means many branches in flight in parallel. Today, every framework assumes one stack per machine — port 5432, container `myapp_postgres_1`, seed data shared across whoever happens to be running. Two agents on two branches collide instantly. levelzero treats parallel stacks as the **default**, not an advanced configuration.

### HTTP ingress: portless

HTTP-facing services (api, web) are exposed via [portless](https://github.com/vercel-labs/portless). Portless solves a chunk of the multi-worktree problem out of the box:

- Native git worktree detection: branch name becomes a subdomain prefix automatically (`https://feature-x.myapp.localhost`, `https://api.feature-x.myapp.localhost`).
- Random port assignment under the hood — the agent never sees a port for HTTP services, only stable named URLs.
- Per-service subdomains (`api.myapp.localhost`, `myapp.localhost`).
- HTTPS + HTTP/2 with an auto-trusted local CA.
- One proxy process serves every worktree's web and api simultaneously.

`levelzero init` writes the necessary `portless.json` / `package.json` `"portless"` keys; `levelzero dev` runs the api and web through portless. The CLI resolves a worktree's URLs by asking portless (or by deriving them from the worktree branch and project name) — the agent never needs to know.

### Worktree key

Even with portless handling HTTP, levelzero still needs an internal identifier for non-HTTP resources (Postgres container, log directory, registry entries). Every stack is identified by a **worktree key**: a stable identifier derived from the absolute, canonical path of the worktree root (the directory containing `levelzero.config.ts`). Using the full path — not just the directory name — avoids collisions when two worktrees share a basename.

A machine-local registry at `~/.levelzero/registry.json` tracks what levelzero itself manages (Docker resources, log dirs) — portless owns HTTP route state separately:

```jsonc
{
  "stacks": {
    "<sha256(absolute_path)[:12]>": {
      "path": "/Users/ryan/code/myapp-worktrees/feature-x",
      "branch": "feature-x",
      "postgresPort": 54123,            // dynamic, internal — not surfaced to agent
      "containers": ["levelzero-a3f8c1-postgres"],
      "network": "levelzero-a3f8c1",
      "logDir": ".levelzero/logs",
      "urls": {                          // resolved from portless, cached for convenience
        "web": "https://feature-x.myapp.localhost",
        "api": "https://api.feature-x.myapp.localhost"
      },
      "createdAt": "..."
    }
  }
}
```

### Postgres and other non-HTTP services

Postgres can't go through portless (not HTTP). levelzero allocates a free port at first `dev`, persists it to the registry, reuses it across restarts. The api process gets `DATABASE_URL` injected with that port — agents and tests never see the port directly; they use `levelzero db inspect` and `levelzero curl` respectively.

### Container and network isolation

Every Docker resource is namespaced by the worktree key:

- Containers: `levelzero-<key>-<service>` (e.g. `levelzero-a3f8c1-postgres`).
- Networks: `levelzero-<key>`.
- Volumes: `levelzero-<key>-<service>-data`.

`stacks stop --all` and `stacks prune` work off the `levelzero-` prefix.

### Auto-detection

Every CLI command walks up from `cwd` until it finds a `levelzero.config.ts`. That directory's absolute path is the worktree key. The CLI loads the registry entry for that key and routes the command to the correct stack: `levelzero test` runs against this stack's ports, `levelzero logs` reads this stack's log directory, `levelzero curl` hits this stack's API. The agent never specifies the stack explicitly.

If no `levelzero.config.ts` is found, the command errors with an actionable message ("not inside a levelzero project; run `levelzero init` or `cd` into one").

### Tests target the correct stack

Vitest and Playwright runners are spawned with the auto-detected stack's connection details injected as environment variables:
- `DATABASE_URL` — the auto-allocated Postgres port for this worktree.
- `API_URL` — the portless URL (e.g. `https://api.feature-x.myapp.localhost`).
- `AUTH_URL` — same root as `API_URL` or its own subdomain.

Tests never reference `localhost:5432` or hardcoded URLs directly — they consume the env vars provided by the runner. Tests on worktree A run against stack A, tests on worktree B run against stack B, concurrently and without collision.

### Out-of-scope for v0 (worktree-specific)

- Cross-stack data sharing (e.g. "snapshot stack A's DB into stack B"). Each stack is fully independent.
- Remote stacks (running someone else's worktree's stack on your machine for collaboration). Local only.

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
- **`onboard`** — first-time setup when an agent lands in a levelzero project. Reads config, runs doctor, surveys the skill library.

### Reference skills (nouns — the lookup library)

One per stack tool, stack-specific (not generic vendor docs): how *this stack* uses the tool, conventions, gotchas, common patterns.

- `prisma`, `hono`, `next`, `better-auth`, `vitest`, `playwright`, `turbo`, `levelzero-cli`.

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

interface BrowserAdapter {
  screenshot(route: string, opts: ScreenshotOpts): Promise<Image>;
  visualDiff(baseline: Image, current: Image): Promise<DiffResult>;
  // SDK-side methods used by e2e tests
  drive(): BrowserSession;
}
```

The CLI never imports a specific tool. It loads adapters via `levelzero.config.ts` and dispatches.

## `init` and scaffolding (v0)

`levelzero init` is template-based: one template per adapter combination. v0 ships exactly one combination (the v0 stack), so `init` is a single template rendered into the target directory. Future combinations add templates. The framework intentionally avoids generators/codemods for converting between adapter combinations in v0 — that's a v2+ problem.

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
- **Review bots.** GitHub Actions running `levelzero check` and skill-driven conformance review. Ecosystem follow-on.
- **Adapter implementations beyond the v0 stack.** Drizzle, TanStack Start, pnpm, etc. — interfaces designed for them, implementations land later.
- **Generators/codemods for swapping adapters in an existing project.** v2+.

## Open questions

- Naming and packaging of the published artifact (`@levelzero/cli`? `levelzero` standalone binary?).
- How `levelzero.config.ts` versioning interacts with CLI version skew across long-lived projects.
- The exact shape of structured `--help` output (likely OpenAPI-ish or a custom schema; needs prototyping).
- Whether `levelzero impact` is LSP-backed, ts-morph-backed, or a thin wrapper around an existing tool — decision deferred to implementation.
