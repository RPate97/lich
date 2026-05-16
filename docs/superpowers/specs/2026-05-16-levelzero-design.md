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

### Lifecycle

- `levelzero init` — scaffold a project; prompts (or takes flags) for adapter choices; writes `levelzero.config.ts`.
- `levelzero dev` — bring up Postgres + api + web; tee structured logs to `.levelzero/logs/`.
- `levelzero stop` — clean teardown.
- `levelzero reset` — nuke DB, re-migrate, re-seed. The "known starting point" command.
- `levelzero doctor` — diagnose local environment. Used by agents for self-diagnosis.

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

- `levelzero logs [--service <name,...>] [--grep <pattern>] [--since <time>] [--level <level>] [--tail <n>] [--follow]` — unified query across owned services and Docker-managed infra. Structured JSON output by default. Critical to the validation loop: when a test fails, the agent grabs logs by time window without per-test wiring.

### Codegen

- `levelzero gen client` — regenerate `packages/api-client` from Hono types.
- `levelzero gen types` — anything else type-derived.

### Meta

- `levelzero adapter list` / `levelzero adapter swap <slot> <impl>` — see or change adapter choices.

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
