---
name: lich-cli
description: Full command reference for the lich CLI
applies-to: reference
---

# lich CLI

The `lich` binary is the single entry point for working in a project.
Every command resolves the current worktree before doing anything, so cd
into the worktree first. Run any command with `--help` for flags.

## Project lifecycle

- `lich init <name>` — scaffold a new project from the bundled v0
  template into `<name>/`. Writes `.lich/config.ts` and the standard
  `apps/`, `prisma/`, and `tools/` layout. Refuses to overwrite a non-empty
  directory.
- `lich doctor` — diagnose the local environment: registry writable,
  worktree detected, Docker reachable, config valid. Run this first when
  anything misbehaves.

## Running the stack

- `lich up` — boot the full stack for this worktree: Postgres in
  Docker, then the api, then the web app. Ports are allocated dynamically
  per worktree so multiple branches coexist. Prints the assigned URLs.
- `lich down` — tear down this worktree's containers; volumes
  persist so the next `dev` has the same data.
- `lich reset` — like `stop` but also nukes the Docker volumes, then
  brings the stack back up empty. Destructive — confirm before running.
- `lich urls` — print `{service, host, target}` for every service
  in the current stack. Sources from portless when available, falls back
  to `http://localhost:<port>`.
- `lich logs [--service=api,web] [--level=info|error] [--grep <re>] [--since -5m] [--tail N]`
  — stream filtered logs from the running owned services.

## Stack registry (cross-worktree)

- `lich stacks.current` — show which stack the CLI would target from
  the current directory. Useful when several worktrees are open.
- `lich stacks.list` — list every running lich stack on the
  machine with its key, path, branch, and port map.
- `lich stacks.prune` — remove registry entries whose worktree path
  no longer exists on disk. Containers untouched.
- `lich stacks.stop-all` — stop and remove every lich container
  on the machine. Emergency reset; use sparingly.

## Database (Prisma)

- `lich db.migrate --name <short-description>` — generate a new SQL
  migration from `prisma/schema.prisma` and apply it to the dev database.
  Regenerates the client on success.
- `lich db.migration.new --name <short-description>` — scaffold an
  empty migration for manual SQL edits without applying it.
- `lich db.seed` — run `prisma/seed.ts` against the dev database
  with the correct env loaded.
- `lich db.inspect` — print the live schema (tables, columns,
  indexes) so you can verify a migration applied as expected.

## UI components (shadcn)

- `lich ui.add <component>` — vendor a shadcn component into
  `apps/web/src/components/ui/`, installing peer deps and updating
  `components.json`. Pass `--no-overwrite` to keep local edits.
- `lich ui.list` — list shadcn components already installed in
  `apps/web`.

## Code generation

- `lich gen` — run every registered generator (plugin-extensible).
  Each plugin contributes its own generators via `api.addGenerator(...)`;
  the command iterates them and reports per-id status.
- `lich gen --only <id1,id2,...>` — restrict the run to specific
  generator ids. Example: `lich gen --only api-client` only emits
  the typed API client; `lich gen --only prisma` only runs
  `prisma generate`.
- `lich gen --list` — show the registered generators with their
  one-line descriptions.
- `lich gen [--api-dir apps/api] [--out ...]` — unknown flags pass
  through to each generator. The `api-client` generator (from
  `@lich/plugin-typed-client`) understands `--api-dir` and `--out`;
  other generators ignore them.

## Quality and review

- `lich check` — run framework-level conformance rules across the
  project (routing structure, generated-file freshness, banned imports).
- `lich impact <file>` — list every TS/JS file that depends on the
  given file (reverse dependency graph). Use this before refactoring a
  shared module.
- `lich coverage [--threshold N]` — run the test suite with coverage
  and emit a JSON summary; exits non-zero if any file is below threshold.

## Visual checks

- `lich screenshot <url> [--width N] [--height N] [--out path.png]`
  — capture a PNG of a rendered page via Playwright.
- `lich visual.diff <a.png> <b.png> [--out diff.png]` — compute a
  pixel diff between two screenshots; non-zero exit on any difference.
