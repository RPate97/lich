> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# lich Implementation Roadmap

**Spec:** [2026-05-16-levelzero-design.md](../specs/2026-05-16-levelzero-design.md)

The v0 design covers many independent subsystems. Building them in one plan would be unmanageable; each subsystem below produces working, testable software on its own and is delivered as a separate plan document.

The order is dependency-driven: earlier plans unblock later ones. Some later plans are parallelizable (noted).

---

## Sequence

### Plan 01 — CLI foundation
File: `2026-05-16-levelzero-01-cli-foundation.md`

Builds the `lich` binary, config loading, worktree key detection, the machine-local registry, structured output, the command framework, and a starter set of registry-only commands (`init`, `stacks current`, `stacks list`, `stacks prune`, `doctor`). No Docker, no services running — just the skeleton.

**Produces:** an installable CLI that can scaffold a `lich.config.ts`, detect which worktree you're in, and report registry state. Foundation for everything else.

---

### Plan 02 — Service contract + Postgres
File: `2026-05-16-levelzero-02-services-postgres.md`

Introduces the `Service` interface, the port allocator, the Docker container/network/volume namespacing scheme, and Postgres as the first service implementation. Adds `lich up` (single-service flavor), `lich down`, `lich reset`.

**Produces:** `lich up` brings up a worktree-isolated Postgres, port allocated and persisted, container/volume namespaced by worktree key. Two worktrees can run simultaneously.

---

### Plan 03 — Owned services (api + web) + log aggregation
File: `2026-05-16-levelzero-03-owned-services-logs.md`

Adds the `kind: 'owned'` Service flavor (managed processes), the structured log writer that tees per-service jsonl into `.lich/logs/`, and the `lich logs` query command. Wires up the Hono api and Next web as the first two owned services. Adds Next dev-rewrite for `/api/*` → api port.

**Produces:** `lich up` brings up Postgres + api + web together; `lich logs` queries across all of them with grep/since/service filters.

---

### Plan 04 — portless integration for web
File: `2026-05-16-levelzero-04-portless-web.md`

Wires the web service through portless for human-readable per-worktree URLs. Adds the fallback path when portless isn't available.

**Produces:** `https://<branch>.myapp.localhost` resolves to the right worktree's web frontend.

---

### Plan 05 — Database commands + Prisma adapter
File: `2026-05-16-levelzero-05-db-prisma.md`

Defines the `ORMAdapter` interface and the Prisma implementation. Adds `lich db migrate`, `db migration new`, `db seed`, `db inspect`.

**Produces:** schema lifecycle managed through the CLI, working against the auto-detected stack's Postgres.

---

### Plan 06 — Auth commands + Better Auth adapter
File: `2026-05-16-levelzero-06-auth-better-auth.md`

Defines the `AuthAdapter` interface and the Better Auth implementation. Adds `lich curl --as <user>` (depends on auth for session handling) and test-side session helpers.

**Produces:** auth flows working end-to-end; `lich curl --as alice /api/me` returns alice's session.

---

### Plan 07 — Test runners + integration test harness
File: `2026-05-16-levelzero-07-test-runners.md`

Adds `lich test [unit|integration|e2e]` with auto-detected stack env injection. Implements the transactional-rollback integration test isolation strategy. Wires up Vitest + Playwright via adapter slots.

**Produces:** `lich test integration` runs Vitest with `DATABASE_URL`/`API_URL` pointing at the current worktree's stack.

---

### Plan 08 — Impact analysis + coverage + check
File: `2026-05-16-levelzero-08-validation-tools.md`

Adds `lich impact <path|symbol>`, `lich coverage`, `lich check` (with v0 built-in rules: route coverage, schema/migration consistency, type-client freshness). Pluggable rule API.

**Produces:** the agent has deterministic "what does this affect" and "what's untested" tooling.

---

### Plan 09 — Codegen (api-client) + Hono adapter
File: `2026-05-16-levelzero-09-codegen-hono.md`

Defines the `FrontendAdapter` and the Hono backend adapter (route manifest, type extraction). Adds `lich gen client` to regenerate `packages/api-client`.

**Produces:** typed Hono client auto-generated; web frontend consumes types from `packages/api-client`.

---

### Plan 10 — UI commands + shadcn adapter + Playwright/browser
File: `2026-05-16-levelzero-10-ui-browser.md`

Defines `UIAdapter` (shadcn impl) and `BrowserAdapter` (Playwright impl). Adds `lich ui add`, `ui list`, `screenshot`, `visual diff`. Sets up the visual regression baseline workflow.

**Produces:** components added through the CLI, screenshots captured per worktree, visual regression working.

---

### Plan 11 — Scaffolder (`init`) + the starter template
File: `2026-05-16-levelzero-11-scaffolder-template.md`

Builds out `lich init` from a minimal config-only scaffold (plan 01) into a full project generator: monorepo layout, Hono api with Better Auth wired, Next web with Tailwind + shadcn, Prisma schema, base seed, base e2e tests, CLAUDE.md, the full skill set. One template combination (the v0 stack).

**Produces:** `lich init my-app` yields a working monorepo with `lich up` immediately usable.

---

### Plan 12 — Skills authoring + CLAUDE.md generator
File: `2026-05-16-levelzero-12-skills-claude-md.md`

Writes the workflow skills (`change`, `debug`, `onboard`) and reference skills (`prisma`, `hono`, `next`, `tailwind`, `shadcn`, `better-auth`, `vitest`, `playwright`, `turbo`, `lich-cli`). Adds `lich skills index` to regenerate CLAUDE.md from the skills directory.

**Produces:** agents landing in a lich project have a complete skill library to work with.

---

### Plan 13 — Adapter swap CLI + extensibility surface polish
File: `2026-05-16-levelzero-13-extensibility.md`

Adds `lich adapter list / swap`. Ensures the Service contract, adapter registration, command plugin surface, check-rule registration, and skill discovery are all driveable from `lich.config.ts` and project-local plugin paths. Documents the extension surface (not heavily — this is v0).

**Produces:** project owners can add Redis (or similar) to their stack via config alone.

---

## Parallelization opportunities

After Plan 03 (dev/stop/logs working), several plans can run in parallel:
- **05 (DB/Prisma)** and **06 (Auth/Better Auth)** are independent of each other.
- **08 (validation tools)** only depends on 01.
- **10 (UI/browser)** only depends on 03.
- **12 (skills)** can be drafted alongside the implementation work it documents.

The critical path is roughly: 01 → 02 → 03 → 05 → 09 → 11. The rest fan out.

---

## Cross-cutting conventions for every plan

- **TDD.** Failing test first, implement to green, commit.
- **One small commit per task.** Bisectable history.
- **Each plan adds something the previous plan couldn't do**, and you can `git checkout` to the end of any plan and have working software.
- **`tools/cli` is the only source of CLI behavior.** Adapters live in `tools/cli/src/adapters/<slot>/<impl>/`.
- **No placeholders** in code or plans. If a step changes code, the code is in the step.
