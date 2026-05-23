# Plan 05 — Database commands + Prisma adapter

**Goal:** Define `ORMAdapter` interface, implement Prisma adapter (shell-out to Prisma CLI against the auto-detected stack's `DATABASE_URL`), and ship `lich db migrate / db migration new / db seed / db inspect` commands.

**Architecture:**
- ORMAdapter is capability-shaped — methods describe what the adapter does, not which tool. v0 only ships the Prisma implementation.
- Commands resolve the stack via `resolveStackContext`, derive `DATABASE_URL` from the registry entry, invoke the adapter.
- Test fixtures use a real Postgres started by plan-02's `lich dev` machinery.

**Files (cumulative):**
```
tools/cli/src/
  adapters/
    orm/
      types.ts                  # ORMAdapter interface
      prisma.ts                 # Prisma implementation (shell-out to prisma CLI)
  commands/
    db/
      migrate.ts
      migration-new.ts
      seed.ts
      inspect.ts
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 05.1 | ORMAdapter interface | 1 | `adapters/orm/types.ts` |
| 05.2 | Prisma adapter (shell-out helpers + project bootstrap) | 2 | `adapters/orm/prisma.ts` |
| 05.3 | `db migrate` command | 3 | `commands/db/migrate.ts` |
| 05.4 | `db migration new` command | 3 | `commands/db/migration-new.ts` |
| 05.5 | `db seed` command | 3 | `commands/db/seed.ts` |
| 05.6 | `db inspect` (schema + rows JSON dump) | 3 | `commands/db/inspect.ts` |
| 05.7 | Wire `db.*` into bin + e2e | 4 | `bin.ts` + tests |

Wave 3 is fully parallel (4 agents). Wave 1 + 2 are sequential single agents.

## New deps

- `prisma` + `@prisma/client` (devDependency for plan 05; runtime needs depend on consumer projects).

## Verification

- `lich dev` brings up postgres; `lich db migrate` runs migrations against it; `db inspect --schema` returns JSON schema; `db inspect --rows <table>` returns JSON rows.
- Full vitest suite green; tsc clean.
