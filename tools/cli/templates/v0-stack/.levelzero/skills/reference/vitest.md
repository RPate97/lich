---
name: vitest
description: Vitest unit and integration test reference for the levelzero stack
applies-to: reference
---

# Vitest

Vitest runs every non-browser test in the repo. Configs live next to the code
they test: `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, and
`tools/cli/vitest.config.ts`. Run the full suite via
`levelzero test unit` or `levelzero test integration`.

## Test layout

- Co-locate tests with the source: `foo.ts` next to `foo.test.ts`. Avoid a
  parallel `__tests__/` tree — it splits attention.
- Group related assertions under `describe(...)`. Use `it(...)` (not `test`)
  for consistency with the rest of the codebase.
- Prefer table-driven tests via `it.each([...])` over copy-pasting cases.

## Fixtures and mocking

- Use `vi.mock('./module')` at the top of the file; mocks hoist above
  imports automatically. Reset between tests with `vi.resetAllMocks()` in
  `beforeEach` if any test calls `mockImplementation`.
- For shared fixtures (a seeded user, a fake clock), export a factory from
  `test/fixtures/` and call it from each test — never share mutable state
  across files.
- Mock the Prisma client per-test with `vi.mock('@/db', () => ({ db: ... }))`
  for unit tests. Reach for the real database only in integration tests run
  via `levelzero test integration`, which boots the dev Postgres first.

## Snapshots

- Use snapshots sparingly — only for stable serialized output (formatted
  errors, generated SQL). Refresh with `vitest -u` and review the diff.

## Pitfalls

- `vi.useFakeTimers()` leaks into adjacent tests unless paired with
  `vi.useRealTimers()` in `afterEach`.
- Async assertions must be awaited; an unawaited `expect(...).resolves` is
  a silent pass.
