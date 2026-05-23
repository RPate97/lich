# Lich v1 — Agent Context

> If you are an agent (or human) about to do any work in this repo: **read this file fully, then read the required-reading files listed below before you make any changes.** Skipping this step is the most common way agents produce work that doesn't fit the project.

## What this project is

**Lich** is a worktree-scoped dev stack orchestrator. One YAML file describes your stack (containers, host processes, env, lifecycle, profiles, custom commands); the lich CLI runs it with per-worktree isolation so multiple stacks can coexist on one machine without colliding. Primary use case: parallel agent-driven dev workflows.

It's a single binary that wraps `docker compose` + host process supervision + an HTTP dashboard. It is NOT a framework, NOT a runtime, NOT a plugin ecosystem.

## Current state (2026-05-23)

- **v0 (`levelzero`)** was a multi-package plugin-based implementation. **It is fully archived** in `docs/archive-v0/`, `docs/superpowers/specs/archive-v0/`, and `docs/superpowers/plans/archive-v0/`. Do not follow its guidance.
- **v1 (`lich`)** is the current direction. Design is complete. Implementation is structured as 7 sequential plans (Plan 0 written; Plans 1–6 written as we're ready to execute each).
- **Plan 0 (Foundation)** sets up the new `packages/lich/` skeleton, the `examples/dogfood-stack/` failing test case, and the `tests/e2e/` infrastructure. After Plan 0 runs, every e2e test fails (lich is a stub). Each subsequent plan turns tests green tier by tier.

## REQUIRED READING — read these files in order before starting any task

1. **`docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`** — how we test lich v1. Defines the two-tier requirement (unit + e2e), what every command's e2e tests must verify, anti-patterns to avoid. Non-negotiable; read this first because it shapes every implementation step.
2. **`docs/superpowers/specs/2026-05-23-lich-v1-design.md`** — the product spec. Source of truth for what lich does. Read the sections relevant to your task; skim the rest.
3. **The current plan you are executing** — currently `docs/superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md`. Tells you exactly which files to touch and what code to write. Follow the task structure (bite-sized steps; commit at the end of each task).
4. **`examples/dogfood-stack/lich.yaml`** (once it exists, after Plan 0 Task 11) — the failing test case target. This is the config lich must handle by end of v1.

If you find yourself wanting to read anything under any `archive-v0/` directory, stop. Those describe a different system. They will mislead you.

## Project layout (where things live)

```
packages/lich/                # the v1 codebase (single TS package, compiled to single binary)
  src/                        # engine + CLI source
  tests/unit/                 # fast unit tests
  dist/lich                   # compiled binary (after `bun run build`)

examples/dogfood-stack/       # the failing test case — Next + Express + Supabase + migrations + seed
  apps/web/                   # Next.js frontend
  apps/api/                   # Express API
  supabase/                   # Supabase config + migrations
  lich.yaml                   # target config (what lich must handle)

tests/e2e/                    # end-to-end tests; spawn real binary, run against dogfood-stack
  helpers/                    # shared helpers (tmpdir, lich spawn, wait conditions)

docs/superpowers/
  specs/                      # v1 design + testing standards (v0 in archive-v0/)
  plans/                      # implementation plans (v0 in archive-v0/)

packages/core, packages/dashboard, packages/plugin-*, packages/template-v0-stack,
packages/create-stack-v0      # ← all v0 code. Read-only reference until Plan 6
                                cleanup. Don't modify; don't import from new code.
```

## Rules for v1 work

1. **Both tiers, every feature.** Unit tests AND e2e tests. The testing standards doc explains why this is non-negotiable and what each tier must cover.
2. **The real binary in e2e tests.** No mocking the CLI. Spawn `packages/lich/dist/lich` (built first) and assert observable behavior.
3. **Bite-sized commits.** Each task in the plan is a coherent unit of work that gets its own commit. Don't accumulate work across tasks; commit at the end of each one.
4. **Stay scoped to the current task.** Don't reach forward into future tasks or future plans. If you spot a real issue that's out of scope, note it for later rather than fixing it now.
5. **Don't touch v0 code.** Everything in `packages/core/`, `packages/dashboard/`, `packages/plugin-*`, `packages/template-v0-stack/`, `packages/create-stack-v0/` is v0. Read it for reference if porting specific subsystems calls for it; otherwise leave it alone. Cleanup happens in Plan 6.
6. **Don't read v0 docs.** Anything under any `archive-v0/` directory is stale guidance.
7. **Follow the plan's testing/commit/verification structure exactly.** It exists to keep the feedback loop tight.

## Roadmap (subsequent plans, written as we reach each)

- **Plan 1: Core engine** — config parsing + validate, worktree detection, port allocator, compose runner (CLI-agnostic), owned-service runner, env basics, basic ready_when, basic CLI surface
- **Plan 2: Extension surfaces** — env_groups, user-defined commands, lich help/exec/env
- **Plan 3: Profiles** — profile resolution, profile-scoped env, profile-scoped lifecycle
- **Plan 4: Failure surfacing** — fail_when, ready timeout, capture, exit detection, failure UX
- **Plan 5: Daemon + dashboard** — daemon process, dashboard backend, port the dashboard UI, reverse proxy, friendly URLs
- **Plan 6: Onramp + cleanup** — lich:instrument skill, rewrite root README, delete all v0 packages

When a new plan is written, add it to the required-reading list above and update the "current plan" pointer.

## Quick-start commands

```bash
# Build the lich binary
cd packages/lich && bun run build

# Run unit tests
cd packages/lich && bun test

# Run e2e tests
cd tests/e2e && bun test

# Run the lich binary directly
./packages/lich/dist/lich --help
```

## Conventions

- **Commits:** small, focused, one logical change. Use the conventional-commits style (`feat:`, `fix:`, `test:`, `docs:`, `chore:` prefixes) used elsewhere in the repo.
- **Branches:** work on feature branches when applicable; the user manages merges.
- **PRs / amendments:** never amend an existing commit unless explicitly told. Always make a new commit.
- **Hook failures:** if a pre-commit hook fails, fix the underlying issue and create a NEW commit. Don't `--amend`; don't `--no-verify`.

## When in doubt

Re-read the testing standards. Most "I'm not sure how to do this" moments in v1 work are answered by "follow the test recipe and let the failing test guide you."
