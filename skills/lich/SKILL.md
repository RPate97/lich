---
name: lich
description: Use this skill when working in a project that uses lich for dev-stack orchestration. Gives you the on-ramp to understand what lich is, when to use which command, and how to discover the full CLI surface via `lich --help`. Triggers when you see a `lich.yaml` in the project root, when the user mentions "lich up" / "lich logs" / "lich restart" / etc., or when you need to interact with a running dev stack.
---

# lich

You are operating in a project that uses **lich** to run its dev stack. This skill gives you the minimum context to use lich effectively. For specific commands and flags, lich is self-documenting — use `lich --help` and `lich <command> --help`.

## What lich is

Lich is a **worktree-scoped dev stack orchestrator**. It reads one yaml file (`lich.yaml`) describing the project's stack — containers, host processes, env, lifecycle hooks — and brings everything up under per-worktree isolation. Dynamic port allocation, isolated state per worktree, automatic routing through a shared daemon.

A single binary. Wraps `docker compose` for container services, runs host processes directly, supervises both. Not a framework. Not a runtime.

## The problem it solves

You can only run one copy of a typical dev stack on one machine because ports collide, container names collide, compose project names collide. Lich namespaces everything per worktree so N parallel worktrees → N parallel stacks, side by side, no manual port juggling, no `docker compose down` between branches.

For you as an agent: this means you can spin up the user's full dev environment with a single command, run tests against it, modify code, restart affected services, and tear everything down — without breaking the user's other in-flight work in sibling worktrees.

## Core capabilities

- `lich up` — bring the stack up (services start, lifecycle hooks run, dashboard URL printed)
- `lich down` — stop the stack cleanly
- `lich restart [service...]` — restart specific services after code changes
- `lich logs [source...]` — read logs (services or lifecycle phases); paginated by default, exits immediately
- `lich exec <command>` — run an ad-hoc command with the stack's env loaded
- `lich stacks` — list every lich stack running on the machine (across worktrees)
- `lich urls` — print reachable URLs for the running stack
- `lich validate` — statically check a lich.yaml without running anything

There are more (env / nuke / routing / dashboard / init). Run `lich --help` for the full list with one-liners.

## How to discover more

**The CLI is the source of truth.** This skill does not enumerate every flag, exit code, or edge case — that information lives in the binary itself.

- `lich --help` — every command, summarized
- `lich <command> --help` — that command's full usage, flags, examples, exit codes

When a flag does something unexpected or you're unsure which option to pass, check `--help` first before assuming.

## Mental model

- **State per stack:** Every running stack has a state directory at `<LICH_HOME>/stacks/<id>/` (default `LICH_HOME=~/.lich`). Logs, snapshots, routing config — all live there.
- **Worktree scoping:** Your current cwd determines which stack lich operates on. To target a different worktree's stack from a current cwd, use `--worktree <id>` (see `lich <command> --help` for support per command).
- **The daemon is shared:** A single `lich-daemon` runs across all stacks, proxying friendly URLs and serving the dashboard. You don't normally interact with it directly.

## Reading logs

`lich logs` defaults to the last 100 lines across all services, exits immediately (NOT a follow-tail by default — that would block you).

Common patterns:
- `lich logs api` — only api service logs
- `lich logs api --grep error` — filter to error lines
- `lich logs --json` — machine-readable for parsing
- `lich logs --before <cursor>` / `--after <cursor>` — paginate older / newer

The cursor model is stable across live writes (line numbers don't shift when new lines arrive). Use `--json` and consume the `cursor` field if you need to poll for new lines.

## When something goes wrong

- **Service won't start:** `lich logs <service>` will show what happened. Look for env var resolution errors, port collisions, healthcheck timeouts.
- **Whole stack failed to come up:** `lich logs before_up` and `lich logs after_up` show top-level lifecycle hook output.
- **Stack is in a weird state:** `lich down && lich up` for a clean restart. `lich nuke --rescue` cleans up orphaned stacks whose worktrees were deleted.

## Out of scope for this skill

- Writing a lich.yaml from scratch — use the `lich-instrument` skill instead.
- Using the dashboard — that's a human UI, not for agents. The CLI gives you everything the dashboard does.
