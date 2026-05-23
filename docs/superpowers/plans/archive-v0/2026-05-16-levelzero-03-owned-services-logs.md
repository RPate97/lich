> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# lich Plan 03 — Owned services + log aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `kind: 'owned'` Service variant (managed processes — Hono api, Next web, project-added workers), wire it into `lich up` via the `concurrently` library, tee each owned service's stdout+stderr to `.lich/logs/<service>.jsonl`, and add the `lich logs` query command. Plan 03 ships the machinery; the real api/web service definitions and apps land in plan 11 (scaffolder).

**Architecture:**
- `OwnedService` extends the discriminated union alongside `DockerService` (plan 02's placeholder gets replaced with the real shape: `cwd`, `command`, `dependsOn`, `envContributions`).
- A new `runOwnedServices(services, ctx, ports, env)` orchestrator spawns each owned service via `concurrently`, gathers their stdout+stderr, and tees structured JSON lines to per-service log files under `.lich/<key>/logs/<service>.jsonl`.
- `dev` is extended (with backward-compatible DI: `getServices?: () => Service[]`) to start owned services AFTER docker services come up, threading the docker services' `envContributions` into the owned-service env.
- `lich logs` reads jsonl files for the auto-detected stack and supports `--service`, `--since`, `--level`, `--grep`, `--tail`. `--follow` is deferred.

**Tech Stack:** `concurrently` (new dep — first runtime npm package added since plan 01), `node:child_process`, `node:fs` streams, vitest. Bun runs the spawned services natively.

---

## What plan 03 does NOT do

- Does NOT add api/web service definitions to `getBuiltinServices()`. Those land in plan 11's scaffolder alongside the actual `apps/api` and `apps/web` code. Plan 03's tests use inline mock owned services (tiny shell scripts in tmpdirs) to verify the machinery.
- Does NOT implement `--follow` for live log tailing. Deferred to a discovery follow-on.
- Does NOT integrate portless. That's plan 04.
- Does NOT modify `stop` / `reset` / `nuke` beyond what's strictly needed — they already tear down docker services, and owned services are children of the `dev` foreground process so they die when `dev` exits or is killed.

---

## File structure

```
tools/cli/src/
  services/
    types.ts                          # MODIFY: replace OwnedServicePlaceholder with real OwnedService
  owned/
    log-writer.ts                     # tee a child's stdout/stderr to a jsonl file
    runner.ts                         # runOwnedServices: spawn N children via concurrently + log writer
  commands/
    dev.ts                            # MODIFY: extend to start owned services after docker; add getServices DI
    logs.ts                           # lich logs (query jsonl across services for the auto-detected stack)
tools/cli/tests/
  owned/
    log-writer.test.ts                # unit test
    runner.test.ts                    # integration test with inline shell-script owned services
  commands/
    logs.test.ts                      # unit test against test fixtures
    dev.owned.test.ts                 # integration test of dev's owned-service code path
    bin.plan03.e2e.test.ts            # spawn the real bin; verify dev + logs flow
```

---

## Task list

| # | Title | Wave | Dep on |
|---|---|---|---|
| 03.1 | Real `OwnedService` (replace placeholder) | 1 | (plan 02) |
| 03.2 | Per-service log writer | 1 | (plan 02) |
| 03.3 | `concurrently`-based owned-service runner | 2 | 03.1, 03.2 |
| 03.4 | `lich logs` query command | 2 | 03.2 |
| 03.5 | Extend `dev` to start owned services (with `getServices` DI) | 3 | 03.3 |
| 03.6 | Wire `logs` into bin + e2e | 4 | 03.4, 03.5 |

Wave 1: 2 parallel. Wave 2: 2 parallel. Wave 3: sequential single. Wave 4: sequential single.

---

## Conventions for every task

- TDD strictly: failing test, confirm fail, implement, confirm pass, commit.
- Use `./node_modules/.bin/vitest` and `./node_modules/.bin/tsc`.
- Each task = exactly one commit on its own worktree branch.
- All test logs/jsonl writes happen in tmpdirs; never write under the real `~/.lich/`.
- vitest is now configured for `pool: 'forks', singleFork: true` (per LEV-29), so tests run serially.
- Spec says owned services use hot reload by default; tests use trivial `sh` scripts because the runner doesn't care what command it runs.

---

## Open items (not blocking dispatch)

- `--follow` for `logs` — discovery follow-on.
- Restart-on-fail policy for owned services (concurrently supports `restartTries` per command). For plan 03, default to no auto-restart; surface the crash to the operator.
- Log rotation / size cap — discovery follow-on.

---

## Verification (when all 6 tasks complete)

- `bun ./tools/cli/src/bin.ts dev` from a project that declares an owned service (via test fixture, since no scaffolder yet) brings up Postgres + the owned services; concurrently multiplexes their output; `.lich/<key>/logs/<service>.jsonl` accumulates structured log lines.
- `bun ./tools/cli/src/bin.ts logs --service postgres --tail 50 --pretty` returns the latest 50 lines from postgres only.
- `bun ./tools/cli/src/bin.ts logs --grep ERROR --json` returns matching lines as JSON.
- `tsc --noEmit` clean across the suite.
- Vitest suite at ~110 tests, all green.
