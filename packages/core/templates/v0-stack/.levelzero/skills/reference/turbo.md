---
name: turbo
description: Turborepo task pipeline reference for the levelzero stack
applies-to: reference
---

# Turborepo

Turborepo coordinates tasks across the monorepo. The pipeline is declared
in `turbo.json` at the repo root; package-level scripts live in each
`apps/*/package.json` and `tools/*/package.json`.

## Task pipelines

- Declare every task in `turbo.json` with its `dependsOn` chain. Example:
  `build` depends on `^build` (upstream packages built first); `test`
  depends on `build` in the same package.
- Use `outputs: ['dist/**']` so Turbo can cache and restore the artifacts.
  Tasks with no `outputs` are re-run every time.
- Reference env vars via `env` so cache keys invalidate when secrets
  change — never bake env vars into the binary at build time.

## Caching

- Local cache lives in `.turbo/`. Remote cache (when wired) lives behind
  `turbo login` + `turbo link`. CI hits remote first, then local.
- Inspect cache hits with `turbo run build --dry=json`.

## Monorepo conventions

- Workspaces are declared in the root `package.json` under `workspaces`.
- Prefer `turbo run <task>` over `bun --filter` for anything in the
  pipeline — Turbo handles the dependency order; raw filters don't.
