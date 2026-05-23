---
name: prisma
description: Prisma ORM reference for the lich stack
applies-to: reference
---

# Prisma

The schema lives at `prisma/schema.prisma`. The generated client is consumed
from both `apps/api` and `apps/web`. Never edit generated files; only edit the
schema and let the tooling regenerate.

## Editing the schema

- Add or change a model in `prisma/schema.prisma`.
- Run `lich db migrate --name <short-description>` to generate a new
  SQL migration and apply it to the running dev database. This wraps
  `prisma migrate dev` and the appropriate codegen step.
- After the migration succeeds the Prisma client is regenerated automatically.
  If you need to regenerate manually, run `lich gen --only prisma`
  (or `lich gen` to also run the typed API client generator).
- Inspect the live schema with `lich db inspect`. Use this to verify a
  migration applied the columns and indexes you expected before committing.

## Common patterns

- Prefer `cuid()` or `uuid()` for primary keys; reserve `autoincrement()` for
  cases where ordering matters.
- Model relations with explicit `@relation` annotations so renames are safe.
- Use `@@index([...])` on every column you filter or sort by; Postgres will
  not magically create them.
- Wrap multi-write workflows in `prisma.$transaction([...])` so partial
  failures roll back together.

## Pitfalls

- Editing an applied migration directly causes drift. Create a new migration
  instead with `lich db migrate --name fix-<thing>`.
- Don't import `PrismaClient` from `apps/web` server components without
  reusing the shared singleton — each instance opens its own pool.
- Seed data lives in `prisma/seed.ts`; run it with `lich db seed` rather
  than calling `prisma db seed` directly so the right env file is loaded.
