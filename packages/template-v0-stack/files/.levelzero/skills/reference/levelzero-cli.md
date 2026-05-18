---
name: levelzero-cli
description: Full command reference for the levelzero CLI
applies-to: reference
---

# levelzero CLI

The `levelzero` binary is the single entry point for working in a project.
Every command resolves the current worktree before doing anything, so cd
into the worktree first. Run any command with `--help` for flags.

## Project lifecycle

- `levelzero init <name>` — scaffold a new project from the bundled v0
  template into `<name>/`. Writes `.levelzero/config.ts` and the standard
  `apps/`, `prisma/`, and `tools/` layout. Refuses to overwrite a non-empty
  directory.
- `levelzero doctor` — diagnose the local environment: registry writable,
  worktree detected, Docker reachable, config valid. Run this first when
  anything misbehaves.

## Running the stack

- `levelzero dev` — boot the full stack for this worktree: Postgres in
  Docker, then the api, then the web app. Ports are allocated dynamically
  per worktree so multiple branches coexist. Prints the assigned URLs.
- `levelzero stop` — tear down this worktree's containers; volumes
  persist so the next `dev` has the same data.
- `levelzero reset` — like `stop` but also nukes the Docker volumes, then
  brings the stack back up empty. Destructive — confirm before running.
- `levelzero urls` — print `{service, host, target}` for every service
  in the current stack. Sources from portless when available, falls back
  to `http://localhost:<port>`.
- `levelzero logs [--service=api,web] [--level=info|error] [--grep <re>] [--since -5m] [--tail N]`
  — stream filtered logs from the running owned services.

## Stack registry (cross-worktree)

- `levelzero stacks.current` — show which stack the CLI would target from
  the current directory. Useful when several worktrees are open.
- `levelzero stacks.list` — list every running levelzero stack on the
  machine with its key, path, branch, and port map.
- `levelzero stacks.prune` — remove registry entries whose worktree path
  no longer exists on disk. Containers untouched.
- `levelzero stacks.stop-all` — stop and remove every levelzero container
  on the machine. Emergency reset; use sparingly.

## Database (Prisma)

- `levelzero db.migrate --name <short-description>` — generate a new SQL
  migration from `prisma/schema.prisma` and apply it to the dev database.
  Regenerates the client on success.
- `levelzero db.migration.new --name <short-description>` — scaffold an
  empty migration for manual SQL edits without applying it.
- `levelzero db.seed` — run `prisma/seed.ts` against the dev database
  with the correct env loaded.
- `levelzero db.inspect` — print the live schema (tables, columns,
  indexes) so you can verify a migration applied as expected.

## UI components (shadcn)

- `levelzero ui.add <component>` — vendor a shadcn component into
  `apps/web/src/components/ui/`, installing peer deps and updating
  `components.json`. Pass `--no-overwrite` to keep local edits.
- `levelzero ui.list` — list shadcn components already installed in
  `apps/web`.

## Code generation

- `levelzero gen.client [--api-dir apps/api] [--out ...]` — emit a fully
  typed client for the Hono API so `apps/web` can call it with end-to-end
  type inference.

## Quality and review

- `levelzero check` — run framework-level conformance rules across the
  project (routing structure, generated-file freshness, banned imports).
- `levelzero impact <file>` — list every TS/JS file that depends on the
  given file (reverse dependency graph). Use this before refactoring a
  shared module.
- `levelzero coverage [--threshold N]` — run the test suite with coverage
  and emit a JSON summary; exits non-zero if any file is below threshold.

## Visual checks

- `levelzero screenshot <url> [--width N] [--height N] [--out path.png]`
  — capture a PNG of a rendered page via Playwright.
- `levelzero visual.diff <a.png> <b.png> [--out diff.png]` — compute a
  pixel diff between two screenshots; non-zero exit on any difference.
