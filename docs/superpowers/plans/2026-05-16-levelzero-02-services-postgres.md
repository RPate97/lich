# lich Plan 02 — Service contract + Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `Service` interface, the port allocator, the worktree-namespaced Docker resource scheme, and Postgres as the first service implementation. Add `lich dev`, `stop`, `reset`, and `stacks stop --all` so a real stack can be brought up and torn down per worktree, in parallel with other worktrees, with no port or container-name collisions.

**Architecture:**
- `Service` is a discriminated union; plan 02 ships the `DockerService` variant (owned-process services land in plan 03 with concurrently).
- The `dev` command resolves the active stack's built-in services + (eventually) user-added services, allocates port blocks via the registry, names every Docker resource by worktree key, starts containers via `docker compose`, persists the registry entry, and returns connection info.
- The registry from plan 01 gains file locking so concurrent worktrees calling `dev` don't corrupt the shared registry file.

**Tech Stack:** Bun + Node `node:net`/`node:fs`/`node:child_process`, Docker CLI (already on path), Vitest. No new npm deps required beyond plan 01.

---

## File structure

```
tools/cli/src/
  registry-lock.ts                 # advisory file lock for ~/.lich/registry.json
  services/
    types.ts                       # Service, DockerService, StackContext, PortMap, RunningHandle
    runner.ts                      # generic lifecycle wrapper for any Service
    builtins.ts                    # getBuiltinServices() — returns the v0 hardcoded list
    postgres.ts                    # PostgresService (DockerService impl)
  ports/
    allocator.ts                   # allocate a block of free ports in 54000-54999
    free-port.ts                   # is-this-port-free probe (node:net)
  docker/
    naming.ts                      # container/network/volume name helpers
    compose.ts                     # write per-stack docker-compose.yml, shell to docker compose
  commands/
    dev.ts                         # lich dev
    stop.ts                        # lich stop
    reset.ts                       # lich reset
    stacks/
      stop-all.ts                  # lich stacks stop --all
tools/cli/tests/
  (mirrored layout)
```

Each module has one responsibility. Integration tests that need real Docker live under `tests/docker/` and `tests/commands/` and are gated by a small helper that skips if Docker is unreachable.

---

## Task list

| # | Title | Wave | Dep on |
|---|---|---|---|
| 02.1 | Free-port probe + port allocator | 1 | (plan 01) |
| 02.2 | Docker resource naming | 1 | (plan 01) |
| 02.3 | Service contract types | 1 | (plan 01) |
| 02.4 | Registry file lock | 1 | (plan 01) |
| 02.5 | Postgres `DockerService` definition | 2 | 02.1, 02.2, 02.3 |
| 02.6 | Generic Service runner + `getBuiltinServices` | 2 | 02.3, 02.5 |
| 02.7 | `lich dev` (single-worktree) | 3 | 02.4, 02.6 |
| 02.8 | `lich stop` | 3 | 02.6, 02.7 |
| 02.9 | `lich reset` | 3 | 02.7, 02.8 |
| 02.10 | `lich stacks stop --all` | 4 | 02.8 |
| 02.11 | Wire all commands into `bin.ts`; full integration test | 4 | 02.7-02.10 |

Wave 1 is fully parallel (4 agents). Wave 2 is two-agent parallel. Wave 3 is sequential (dev → stop → reset all touch overlapping conceptual surfaces). Wave 4 is two-agent parallel.

---

## Conventions for every task

- TDD strictly: failing test, run-to-confirm-fail, implement, run-to-confirm-pass, commit.
- Use `./node_modules/.bin/vitest` and `./node_modules/.bin/tsc`. Node is now v20 in fresh shells but the local-install path is still the safe default.
- Each task = exactly one commit on its own worktree branch.
- Docker integration tests must skip cleanly if `docker info` fails so non-Docker dev environments don't block the suite. A `tests/_helpers/docker.ts` helper exposing `dockerOrSkip()` is fair game to add in the first Docker-touching task.
- All container names, network names, and volume names go through the helpers in `src/docker/naming.ts` — no string-literal `lich-*-` anywhere else.
- No new npm dependencies in plan 02. Everything is `node:` builtins + child-process to the local `docker` CLI.

---

## Open items (not blocking dispatch)

- Whether to use Docker Compose v2 (`docker compose ...`) or plain `docker run` for service lifecycle. **Decision:** Compose v2 — it gives us project-scoped lifecycle (`docker compose -p <project> down -v`) for free, and the worktree key becomes the compose project name. The per-stack `docker-compose.yml` is generated at `dev` time into `.lich/<key>/docker-compose.yml`.
- Whether to support Linux/Windows now or macOS-only. **Decision:** macOS-only for v0; nothing should hard-fail on Linux but no testing yet.
- How to handle a port collision after registry-recorded allocation. **Decision:** `dev` re-probes the recorded port; if occupied, surface a clear error from `doctor` (not silent reassignment). Plan 02 leaves the "stuck port" recovery story to the discovery backlog.

---

## Verification (when all 11 tasks complete)

- `cd tools/cli && bunx vitest run` green (~50+ tests).
- `cd tools/cli && bun tsc --noEmit` clean.
- From a scratch dir with `lich.config.ts`:
  1. `lich dev` brings up Postgres in a container named `lich-<key>-postgres`, prints the allocated port and `DATABASE_URL`.
  2. `lich stacks current` reports `running: true` with the port and container.
  3. `psql "$DATABASE_URL" -c 'select 1'` succeeds from outside the container.
  4. In a second worktree (`git worktree add ...`), repeat — a second Postgres container comes up on a different port; both run concurrently.
  5. `lich stop` in worktree A tears it down cleanly; B keeps running.
  6. `lich stacks stop --all` from anywhere tears down both.
  7. `lich reset` from a fresh worktree (re-running step 1 first) wipes the volume and brings up an empty DB.
