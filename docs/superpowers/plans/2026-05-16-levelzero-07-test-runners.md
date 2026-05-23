# Plan 07 — Test runners + integration test harness

**Goal:** Ship `lich test [unit|integration|e2e]` with auto-detected stack env injection. Define `TestRunnerAdapter` (Vitest impl, Playwright impl). Implement transactional-rollback integration test isolation via a small Prisma wrapper.

**Architecture:**
- `TestRunnerAdapter`: `run({ pattern, env, watch }) → Promise<TestResult>`. Two impls: `vitestAdapter` (shells out to vitest), `playwrightAdapter` (shells out to `playwright test`).
- `lich test` resolves stack context, derives `DATABASE_URL` + `API_URL` from the registry, injects them into the test runner's env, and chooses the adapter based on `[unit|integration|e2e]` subcommand:
  - `unit` → vitest with `tests/unit/**` pattern, no env injection needed.
  - `integration` → vitest with `tests/integration/**`, env injected; tests use the rollback helper.
  - `e2e` → playwright test, env injected; needs `lich dev` running.
- Transactional rollback helper: `withRollback(prisma, async () => { ... })` wraps the test body in a Prisma transaction that always aborts at the end. Test sees a clean DB on each run; no truncation needed.

**Files:**
```
tools/cli/src/
  adapters/
    test-runner/
      types.ts                  # TestRunnerAdapter
      vitest.ts                 # vitest shell-out
      playwright.ts             # playwright shell-out
  testing/
    rollback.ts                 # withRollback helper (Prisma-aware)
  commands/
    test.ts                     # lich test [unit|integration|e2e]
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 07.1 | TestRunnerAdapter interface | 1 | `adapters/test-runner/types.ts` |
| 07.2 | vitestAdapter (shell-out) | 2 | `adapters/test-runner/vitest.ts` |
| 07.3 | playwrightAdapter (shell-out) | 2 | `adapters/test-runner/playwright.ts` |
| 07.4 | withRollback helper (Prisma transaction wrapper) | 2 | `testing/rollback.ts` |
| 07.5 | `lich test` command (dispatches to adapter by subcommand) | 3 | `commands/test.ts` |
| 07.6 | Wire `test` into bin + e2e | 4 | `bin.ts`, tests |

Wave 2 is 3-way parallel. Waves 3, 4 sequential.

## New deps

None new — vitest + playwright already in tree from plans 02 and 10. Prisma transaction support is built into `@prisma/client` (plan 05).

## Out of scope

- Watch mode UI (vitest's native `--watch` works).
- Test result coverage merging across runners (separate from plan 08 coverage).
- Per-test snapshotting / database snapshots — transactional rollback covers the typical case.
- Distributed test running (single machine in v0).

## Verification

- `lich test unit` runs unit tests with no env injection.
- `lich test integration` runs integration tests against the current worktree's live Postgres (DATABASE_URL injected); `withRollback(prisma, fn)` keeps state clean between tests.
- `lich test e2e` runs Playwright tests against the current worktree's web service.
- Full suite green; tsc clean.
