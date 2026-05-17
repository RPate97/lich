---
name: change
description: How to make a code change in a levelzero project
applies-to: workflow
---

# Making a code change

Follow this loop every time you modify behaviour. It exists so the change
lands with the tests, types, and conformance rules that the rest of the
codebase relies on — skipping a step pushes that work onto the reviewer.

## 1. Orient

- Read `CLAUDE.md` at the repo root. It points at the active stack, the
  framework adapters, and which `levelzero` commands you should prefer.
- Identify the reference skill for the layer you're touching (e.g.
  `.levelzero/skills/reference/hono.md` for an API route,
  `.levelzero/skills/reference/prisma.md` for a schema edit). Skim it before
  writing code so you don't reinvent a convention.

## 2. Assess blast radius

- Run `levelzero impact <path>` on the file you plan to change. The output
  lists reverse dependencies — every test and module that could break.
- If the impact list spans both `apps/api` and `apps/web`, plan to run
  `levelzero types` after the edit; cross-app types are the easiest thing to
  silently break.

## 3. Test-first, then implement

- Add a failing test in the same package as the code you're changing. Use
  `vitest run <file>` while iterating so the feedback loop stays under a
  second.
- Implement the change until the new test passes. Keep the diff focused —
  if you find an unrelated bug, note it and move on.

## 4. Verify and commit

- Run `levelzero check` to execute the framework-level conformance rules
  (forbidden imports, missing migrations, stale generated files). Fix any
  failures before committing — the same rules run in CI.
- Run `levelzero types` for a full typecheck across both apps.
- Commit with a message that explains *why*, not what. The diff already
  shows what.
