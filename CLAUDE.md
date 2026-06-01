# Lich v1 — Agent Context

> If you are an agent (or human) about to do any work in this repo: **read this file fully, then read the required-reading files listed below before you make any changes.** Skipping this step is the most common way agents produce work that doesn't fit the project.

## What this project is

**Lich** is a worktree-scoped dev stack orchestrator. One YAML file describes your stack (containers, host processes, env, lifecycle, profiles, custom commands); the lich CLI runs it with per-worktree isolation so multiple stacks can coexist on one machine without colliding. Primary use case: parallel agent-driven dev workflows.

It's a single binary that wraps `docker compose` + host process supervision + an HTTP dashboard. It is NOT a framework, NOT a runtime, NOT a plugin ecosystem.

## Current state (v1 shipped 2026-05-25)

- **v0 (`levelzero`)** was a multi-package plugin-based implementation. It's **deleted** from `packages/` (post-LEV-445/446 cleanup). Only `docs/superpowers/specs/archive-v0/` and `docs/superpowers/plans/archive-v0/` remain as historical record. Do not follow their guidance.
- **v1 (`lich`)** is the single live codebase at `packages/lich/`. Plans 0-6 shipped. Post-v1 follow-ups (e.g. the `lich:instrument` agent skill, the dogfood-stack feature expansion) are tracked as separate Linear projects; the core orchestrator is complete and dogfooded.

## REQUIRED READING — read these files in order before starting any task

1. **`docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`** — how we test lich v1. Defines the two-tier requirement (unit + e2e), what every command's e2e tests must verify, anti-patterns to avoid. Non-negotiable; read this first because it shapes every implementation step.
2. **`docs/superpowers/specs/2026-05-23-lich-v1-design.md`** — the product spec. Source of truth for what lich does. Read the sections relevant to your task; skim the rest.
3. **The plan that owns your task.** Find it yourself — do not assume. Process:
   - Look at `ls docs/superpowers/plans/*.md` to see every active plan (ignore `archive-v0/`).
   - Each plan filename is `YYYY-MM-DD-<topic>.md`. Match your task to one of the plans by scope.
   - When uncertain (multiple plans seem to overlap, or your task isn't clearly named anywhere), STOP and ask. Do not guess; doing the wrong plan's work is worse than waiting for clarification.
   - Once identified, read that plan **fully** — not just the task you've been given. Plans contain shared context (architecture, file structure, conventions) that earlier sections establish for later tasks. Tasks read out of context produce out-of-context code.
4. **`packages/e2e/fixtures/dogfood-stack/lich.yaml`** — the canonical example config. Postgres compose service + api/web/tunnel_demo owned services + profile coverage (dev:fast is the default; dev opt-in for DB; dev:env-override for env precedence demos).

If you find yourself wanting to read anything under any `archive-v0/` directory, stop. Those describe a different system. They will mislead you.

## Project layout (where things live)

```
packages/lich/                # the v1 codebase (single TS package, compiled to single binary)
  src/                        # engine + CLI source
  src/daemon/dashboard/ui/    # the dashboard React SPA (separate vite build)
  tests/unit/                 # fast unit tests
  dist/lich                   # compiled binary (after `bun run build`)
  dist/lich-daemon            # daemon companion binary

packages/e2e/fixtures/dogfood-stack/       # the canonical example — Next + Express + Postgres
  apps/web/                   # Next.js frontend
  apps/api/                   # Express API (Bun.sql against postgres)
  db/                         # migrations + seed
  compose.yaml                # postgres compose passthrough (image/healthcheck/tmpfs)
  lich.yaml                   # the stack config

packages/e2e/                 # end-to-end tests; spawn real binary, run against dogfood-stack
  tests/                      # per-feature .test.ts files
  helpers/                    # shared helpers (tmpdir, lich spawn, wait, dbmode, urls)
  vitest.workspace.ts         # dual-pool config (fast = dev:fast, heavy = dev + sandbox/Tart)
  _pool-manifest.ts           # which tests need the heavy pool (long timeouts, singleFork)
  AUDIT.md                    # per-test pool assignment + hardening notes

docs/superpowers/
  specs/                      # v1 design + testing standards (v0 in archive-v0/)
  plans/                      # implementation plans (v0 in archive-v0/)
```

## Rules for v1 work

1. **Both tiers, every feature.** Unit tests AND e2e tests. The testing standards doc explains why this is non-negotiable and what each tier must cover.
2. **The real binary in e2e tests.** No mocking the CLI. Spawn `packages/lich/dist/lich` (built first) and assert observable behavior.
3. **Bite-sized commits.** Each task in the plan is a coherent unit of work that gets its own commit. Don't accumulate work across tasks; commit at the end of each one.
4. **Stay scoped to the current task.** Don't reach forward into future tasks or future plans. If you spot a real issue that's out of scope, note it for later rather than fixing it now.
5. **Don't read v0 docs.** Anything under any `archive-v0/` directory is stale guidance.
6. **Follow the plan's testing/commit/verification structure exactly.** It exists to keep the feedback loop tight.
7. **Comments: default to none.** The codebase had a comprehensive comment-cleanup pass; match that style. Only add a comment when the WHY is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Never write multi-paragraph docstrings or multi-line comment blocks; one short line is the maximum. Don't explain WHAT the code does (well-named identifiers do that). Don't reference the current task, fix, or callers ("added for X", "handles case from LEV-123") — those belong in the commit message and rot as the codebase evolves. If removing a comment wouldn't confuse a future reader, don't write it.

## Roadmap

- **Plan 0: Foundation** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md` — SHIPPED
- **Plan 1: Core engine** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-1-core-engine.md` — SHIPPED
- **Plan 2: Extension surfaces** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-2-extension-surfaces.md` — SHIPPED
- **Plan 3: Profiles** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-3-profiles.md` — SHIPPED
- **Plan 4: Failure surfacing** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-4-failure-surfacing.md` — SHIPPED
- **Plan 5: Daemon + dashboard** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-5-daemon-dashboard.md` — SHIPPED
- **Plan 6: Onramp + cleanup** — `docs/superpowers/plans/2026-05-23-lich-v1-plan-6-onramp-cleanup.md` — v0 cleanup DONE; README rewrite + `lich:instrument` skill remaining

Subsequent design + plan docs (under `docs/superpowers/specs/` and `docs/superpowers/plans/`, dated 2026-05-25 onwards) cover the e2e suite redesign (solid + fast) and the dogfood-stack expansion. Read those if your task touches the suite shape or the dogfood-stack itself.

## Quick-start commands

```bash
# Build the lich binary
cd packages/lich && bun run build

# Run unit tests
cd packages/lich && bun test

# Run e2e tests (both pools, ~5 min wall clock)
cd packages/e2e && bun run test

# Run just the fast pool (no docker, ~3 min)
cd packages/e2e && bunx vitest run --project fast

# Run the lich binary directly
./packages/lich/dist/lich --help
```

### Running e2e tests

Requires:

- Docker Desktop (or OrbStack) running, for the docker-dependent tests in the `heavy` pool
- Tart (optional) for the sandbox tests in the `heavy` pool — auto-skipped if missing
- The `fast` pool needs neither; it runs `dev:fast` (api + web on the host)

If docker isn't running, the docker-dependent `heavy` pool tests will fail with a connectivity error — that's correct, those tests exist to verify docker-orchestrated behavior. The sandbox/Tart tests in the heavy pool auto-skip when Tart isn't installed. The `fast` pool runs independently and is the right preflight check during local iteration.

## Conventions

- **Commits:** small, focused, one logical change. Use the conventional-commits style (`feat:`, `fix:`, `test:`, `docs:`, `chore:` prefixes) used elsewhere in the repo.
- **Branches:** work on feature branches when applicable; the user manages merges.
- **PRs / amendments:** never amend an existing commit unless explicitly told. Always make a new commit.
- **Hook failures:** if a pre-commit hook fails, fix the underlying issue and create a NEW commit. Don't `--amend`; don't `--no-verify`.

## When in doubt

Re-read the testing standards. Most "I'm not sure how to do this" moments in v1 work are answered by "follow the test recipe and let the failing test guide you."
