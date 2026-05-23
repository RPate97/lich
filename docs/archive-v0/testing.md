> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../superpowers/specs/2026-05-23-lich-v1-design.md` (product spec), `../superpowers/specs/2026-05-23-lich-v1-testing-standards.md` (testing standards), and `../superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md` (current plan). See `./README.md` in this directory for context.

---

# Testing tiers

lich has three test tiers. The right tier for new code depends on which
seam you're exercising and what kind of regression you want to catch.

## 1. Unit (`tests/**/*.test.ts`)

**Filename:** `<thing>.test.ts` anywhere under a package's `tests/`.

**What it does:** pure logic, no I/O, no subprocess, no docker. Mocks
liberally — file systems, registries, child processes.

**Why it exists:** fast feedback (< 1s per file) on the small piece of logic
under test. Catches API regressions and shape mismatches.

**When to write one:** any pure function, any branchy logic in a single
module, any state machine you can drive without side effects.

**Run with:** `bun run test` (root) or `bun run test` in a package.

## 2. Integration (`tests/**/*.e2e.test.ts`)

**Filename:** `<thing>.e2e.test.ts` co-located with units (NOT under
`tests/e2e/`).

**What it does:** drives a single command through real code paths. May use
real filesystems via tmpdir fixtures, may spawn real child processes for a
narrow purpose, may use real docker if the scope is tight (one container,
one assertion).

**Why it exists:** catches integration regressions in a single command
without paying the full dogfood-scaffold cost. The existing
`bin.plan14.smoke.e2e.test.ts` is in this tier — it walks the canonical
user flow but cheats on `bun install` by scaffolding inside `packages/`
so the workspace `node_modules/@lich/*` symlinks resolve bare imports.

**When to write one:** a command-level change where you want to exercise the
registered command's handler against a real registry + real filesystem.

**Run with:** `bun run test` — they live in the default `vitest` include
pattern.

## 3. Dogfood (`tests/e2e/*.e2e.test.ts`)

**Filename:** `<thing>.e2e.test.ts` under `packages/core/tests/e2e/`.

**What it does:**

1. Scaffolds a real project into an OS tmpdir (NOT under `packages/`).
2. Runs a real `bun install` against `file:` overrides pointing at the
   workspace packages. After this step, `node_modules/.bin/lich` exists
   and the project tree is structurally identical to what a `bunx
   @lich/create-stack-v0 my-app` user would see after their first
   `bun install`.
3. Exercises the CLI as a real subprocess from the scaffolded project's cwd.
4. Drives the served stack with a real browser (playwright).
5. Cleans up with a guaranteed `docker compose down` + `rm -rf tmpdir` in
   `afterAll`, even on assertion failure.

**Why it exists:** catches the bugs that ship to users. Every other tier
mocks something the user can't mock; this tier doesn't. LEV-198 was created
after seven user-reported bugs slipped past tiers 1 and 2 in a single
afternoon.

**When to write one:** when you want to assert end-to-end behavior — "what
the human at the keyboard sees" — for a user-facing flow. Add a new
dogfood test for each new top-level user journey (CRUD on a fresh
scaffold, swap an adapter, run a custom skill).

**Cost:** ~5 minutes per run on a warm bun cache. Real `bun install`
dominates.

**Run with:**

```
bun run test:e2e
```

Works from the repo root or from `packages/core/` (same script, same
config). Wired through `vitest.e2e.config.ts` (longer timeouts, narrower
include).

## When in doubt

* **Bug a user reported on their machine?** Tier 3 (dogfood). They saw a
  real install + real subprocess; reproduce that.
* **Bug in how command X talks to command Y inside a single process?**
  Tier 2 (integration).
* **Bug in a pure function or a single module's branch logic?** Tier 1
  (unit).

The cheapest test that catches the regression is the right one. Don't
write a dogfood test for a bug a unit test could catch — but don't write
ten unit tests around a problem that only manifests in a real install.

## Adding a new dogfood test

Build on `packages/core/tests/e2e/_helpers/*`:

* `scaffold.ts` — spawns `@lich/create-stack-v0`.
* `install.ts` — writes `file:` overrides, runs `bun install`.
* `cli.ts` — `runCli(projectDir, args)` for subprocess invocation; also a
  `runCliJson` convenience that parses JSON.
* `docker.ts` — `dockerAvailable()` probe + `dockerComposeDown()` teardown
  helper used by `afterAll`.
* `playwright.ts` — `playwrightAndChromiumAvailable()` sync probe +
  `withBrowser(url, fn)` lazy-loads playwright and launches headless
  chromium.

Gate docker-requiring tests with `describe.skipIf(!DOCKER)`. Gate browser-
requiring tests with `describe.skipIf(!DOCKER || !PLAYWRIGHT_OK)` where
`PLAYWRIGHT_OK = playwrightAndChromiumAvailable()` (a sync probe that
checks both the package and the chromium binary). Always wrap teardown in
try/catch — a single broken assertion shouldn't prevent the rest of the
cleanup.

## Marking known-broken bugs

Use `it.fails(...)` when:

* The bug exists today on `master`.
* You want a test that's GREEN today and FLIPS to red when someone either
  (a) introduces a regression that re-breaks the same thing, or (b) fixes
  the underlying bug (because `.fails` requires the assertion to still
  fail).
* The fixer is expected to remove `.fails` as part of their PR.

Cross-reference the open ticket in the test name (`'LEV-204 regression:
...'`) so the maintainer who lands the fix knows what to remove.

Use `it.todo(...)` when the test is too awkward to drive reliably today
(e.g., signal-handling tests that need `spawn` + SIGINT). They show up as
pending in the suite output and document the gap without producing flaky
failures.
