# E2E Suite: Solid + Fast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lich v1 e2e suite fast (target <3 min warm) and solid (no silent coverage loss) by adding a no-compose `dev:fast` profile, splitting tests across parallel vs. singleFork vitest pools, and per-test hardening — all without losing any current assertion.

**Architecture:** Three foundation pieces — DB-tolerant API with explicit `/health` mode signal, `dev:fast` profile (default), and vitest dual-pool config driven by a central `COMPOSE_REQUIRED` manifest — followed by per-test migration (each test = one commit: classify, switch profile if needed, add `expectDbMode` setup assertion, harden).

**Tech Stack:** Bun + TypeScript, Vitest 1.6 (projects API), `Bun.sql` postgres client, Express + Next.js (dogfood-stack apps), docker compose (orchestrated by lich).

**Source:** `docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md` (commit `f55821d`).

**Coordination:** LEV-463 (supabase→postgres swap) landed on master at `9cf131f` before this plan starts. All tasks branch from that or later. No conflict surface.

---

## Conventions

- Build the binary (`cd packages/lich && bun run build`) before any e2e test run.
- `LICH` env var = absolute path to the built binary (e.g. `/Users/ryan/Desktop/programming/levelzero/packages/lich/dist/lich`).
- TDD where applicable. For pure refactors (mechanical migrations), pin behavior with the existing assertions or add a new one before the change.
- Each task = one commit. Use conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).
- Each per-test migration task is independent — agents can pipeline. Per-test commits don't conflict with each other (different files).

---

## PHASE A — FOUNDATION (Tasks 1-7)

These land before any per-test migration. They establish the contracts every test will use.

---

### Task 1: API db.ts — tolerant `sql` client

**Files:**
- Modify: `examples/dogfood-stack/apps/api/src/db.ts`

- [ ] **Step 1: Read the current file**

Run: `cat examples/dogfood-stack/apps/api/src/db.ts`

Confirm it currently throws when `DATABASE_URL` is missing (this is the behavior LEV-463 landed and that this task replaces).

- [ ] **Step 2: Replace the file content**

Overwrite `examples/dogfood-stack/apps/api/src/db.ts` with:

```ts
// Postgres client for the dogfood-stack API. Tolerates the dev:fast
// profile, which intentionally doesn't run postgres (DATABASE_URL is
// empty). Routes that need the DB MUST guard with `dbAvailable()` and
// 503 if false — see ./index.ts for the pattern.
//
// Background: pre-LEV-463 this file used @supabase/supabase-js with a
// hardcoded localhost fallback. LEV-463 migrated to Bun.sql with a
// throw-on-missing. This task softens that throw to a `null` so the
// API can serve /health (and any non-DB routes) under dev:fast.
import { SQL } from "bun";

const url = process.env.DATABASE_URL ?? "";

export const sql = url.length > 0 ? new SQL(url) : null;

export function dbAvailable(): boolean {
  return sql !== null;
}
```

- [ ] **Step 3: Typecheck the api app**

Run: `cd examples/dogfood-stack/apps/api && bun install && bun run -- bunx tsc --noEmit src/db.ts`

(If the api app doesn't have its own typecheck script, the above invocation works. If it errors due to missing `bun` types, add `bun-types` to the api's dev deps — but that's a follow-up; skip if it errors and verify via the index.ts edits in Task 2 instead.)

- [ ] **Step 4: Commit**

```bash
git add examples/dogfood-stack/apps/api/src/db.ts
git commit -m "feat(dogfood/api): tolerate missing DATABASE_URL in db.ts

Replace the throw-on-missing introduced by LEV-463 with a nullable
SQL client + dbAvailable() helper. Enables the dev:fast profile
(no postgres) to serve /health and any non-DB routes; DB-backed
routes must explicitly guard with dbAvailable() — see index.ts."
```

---

### Task 2: API index.ts — `/health` reports DB mode; `/api/things` returns 503 in stub mode

**Files:**
- Modify: `examples/dogfood-stack/apps/api/src/index.ts`

- [ ] **Step 1: Read the current file**

Run: `cat examples/dogfood-stack/apps/api/src/index.ts`

Note that `/health` currently returns `{status: "ok"}` and `/api/things` queries unconditionally.

- [ ] **Step 2: Replace the file content**

Overwrite `examples/dogfood-stack/apps/api/src/index.ts` with:

```ts
import express from "express";
import { dbAvailable, sql } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 4000);

// /health returns the DB mode so callers (especially e2e tests via the
// expectDbMode helper) can verify the active profile matches expectations.
//   db: "live"  → DATABASE_URL set, sql client constructed
//   db: "stub"  → DATABASE_URL empty (dev:fast profile)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", db: dbAvailable() ? "live" : "stub" });
});

app.get("/api/things", async (_req, res) => {
  if (!dbAvailable()) {
    return res.status(503).json({
      error: "DATABASE_URL not configured",
      hint: "This stack is running under the dev:fast profile. Use `lich up dev` for the full DB-backed stack.",
    });
  }
  try {
    // Bun.sql tagged template — parameter-safe.
    const rows = await sql!`select id, name from public.things order by id asc`;
    res.json(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api] postgres error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
```

- [ ] **Step 3: Commit**

```bash
git add examples/dogfood-stack/apps/api/src/index.ts
git commit -m "feat(dogfood/api): /health reports db mode; /api/things 503s in stub mode

/health now returns {status: 'ok', db: 'live'|'stub'} so the new
expectDbMode test helper can verify the active profile matches
expectations. /api/things gates on dbAvailable() and returns 503
with a hint when DATABASE_URL is empty (dev:fast profile)."
```

---

### Task 3: compose.yaml — tmpfs for postgres data

**Files:**
- Modify: `examples/dogfood-stack/compose.yaml`

- [ ] **Step 1: Read the current file**

Run: `cat examples/dogfood-stack/compose.yaml`

- [ ] **Step 2: Add tmpfs mount to the postgres service**

Edit the postgres service block to add a `tmpfs:` entry. The final file should contain (preserve existing fields, just add tmpfs):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: dogfood
    tmpfs:
      # Ephemeral data directory — postgres state lives in RAM and goes
      # away when the container is removed. Tests get a clean DB per
      # `lich down → lich up` cycle without manual volume management.
      # See docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md
      # Section 8 for rationale.
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d dogfood"]
      interval: 1s
      timeout: 1s
      retries: 30
```

(If the existing file's ordering or formatting differs, preserve those; only ADD the `tmpfs:` block.)

- [ ] **Step 3: Smoke-check tmpfs works**

```bash
cd packages/lich && bun run build && cd ../..
LICH=$PWD/packages/lich/dist/lich
mkdir -p /tmp/lich-tmpfs-smoke
LICH_HOME=/tmp/lich-tmpfs-smoke $LICH up dev --no-browser --cwd examples/dogfood-stack
# Verify postgres came up:
LICH_HOME=/tmp/lich-tmpfs-smoke $LICH exec --cwd examples/dogfood-stack -- sh -c 'psql "$DATABASE_URL" -tAc "select count(*) from things"'
# Expected: 3 (seed rows from after_up migration + seed)
LICH_HOME=/tmp/lich-tmpfs-smoke $LICH down --yes --cwd examples/dogfood-stack
rm -rf /tmp/lich-tmpfs-smoke
```

Expected: stack comes up cleanly, query returns `3`.

- [ ] **Step 4: Commit**

```bash
git add examples/dogfood-stack/compose.yaml
git commit -m "feat(dogfood): postgres uses tmpfs for ephemeral test DB

Data directory lives in RAM. Tests get a clean DB per lich down/up
cycle (default anonymous volume previously persisted across cycles,
forcing >= assertions on row counts). Within a single up session
data persists normally. Faster I/O as a side benefit (postgres
healthcheck lands sub-second)."
```

---

### Task 4: lich.yaml — `dev:fast` profile + default flip

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml`

- [ ] **Step 1: Read the current file**

Run: `cat examples/dogfood-stack/lich.yaml | head -80`

Note the current `profiles:` block — `dev` should have `default: true`. This task adds `dev:fast` and moves `default: true` to it.

- [ ] **Step 2: Modify the profiles block**

In `examples/dogfood-stack/lich.yaml`, find the `profiles:` block. Replace it with:

```yaml
profiles:
  # Default profile — no compose service, no DB. Most e2e tests use this
  # for the speed (api + web come up in ~2-3s instead of ~5-8s with
  # postgres). Routes that need DB (api's /api/things) return 503 here
  # — the api code guards on DATABASE_URL presence (see apps/api/src/db.ts).
  dev:fast:
    default: true
    services: []
    owned: [api, web]
    # No after_up — there's no DB to migrate.

  # Full DB-backed stack. Tests that exercise postgres or
  # lifecycle.after_up migrations opt in via `lich up dev`. The api's
  # /health reports db: "live" under this profile (vs "stub" under dev:fast).
  dev:
    services: [postgres]
    # `tunnel_demo` stays here (and only here) — it's relatively cheap
    # but adds no value to dev:fast. Plan 4 capture-pipeline coverage
    # exercises in this profile.
    owned: [api, web, tunnel_demo]
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed.sql

  # Plan 3 Task 18 demo: profile-scoped env precedence. Inherits dev's
  # services/owned/lifecycle via extends; only the env values below
  # override. The DATABASE_URL host is intentionally non-resolving — the
  # e2e coverage asserts on the env Lich resolved (via `lich exec`),
  # not on actually opening a DB connection.
  dev:env-override:
    extends: dev
    env:
      DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/dogfood"
```

- [ ] **Step 3: Validate**

```bash
cd packages/lich && bun run build && cd ../..
./packages/lich/dist/lich validate examples/dogfood-stack/lich.yaml
```

Expected: exit 0, output shows `3 profiles` (was 2; now adds dev:fast).

- [ ] **Step 4: Smoke-check dev:fast comes up without compose**

```bash
LICH=$PWD/packages/lich/dist/lich
mkdir -p /tmp/lich-fast-smoke
LICH_HOME=/tmp/lich-fast-smoke $LICH up --no-browser --cwd examples/dogfood-stack
# Expected: no docker compose invocation; just api + web come up.
# Should complete in 2-3s.
LICH_HOME=/tmp/lich-fast-smoke $LICH exec --cwd examples/dogfood-stack -- curl -s http://localhost:$PORT/health
# Expected: {"status":"ok","db":"stub"}
LICH_HOME=/tmp/lich-fast-smoke $LICH down --yes --cwd examples/dogfood-stack
rm -rf /tmp/lich-fast-smoke
```

(If `$PORT` isn't in scope above, substitute `$(LICH_HOME=/tmp/lich-fast-smoke $LICH urls --cwd examples/dogfood-stack | grep -oE 'api: http://[^[:space:]]+' | sed 's|api: ||')` to get the api URL.)

Expected: api/health returns `{"status":"ok","db":"stub"}`.

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/lich.yaml
git commit -m "feat(dogfood): add dev:fast profile and make it default

dev:fast runs only api + web (no compose, no DB), targeting ~2-3s
stack startup vs. dev's ~5-8s with postgres. The api gracefully
serves /health (reporting db: stub) and 503s on DB-backed routes.

Tests that need DB explicitly opt into dev via lich up dev. The
e2e suite's per-test setup uses expectDbMode to catch any silent
profile drift."
```

---

### Task 5: tests/e2e/helpers/dbmode.ts — `expectDbMode` helper

**Files:**
- Create: `tests/e2e/helpers/dbmode.ts`
- Create: `tests/e2e/helpers/dbmode.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `tests/e2e/helpers/dbmode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expectDbMode } from "./dbmode.js";

describe("expectDbMode", () => {
  it("resolves when /health.db matches expected", async () => {
    // Stub fetch via a temporary global override
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "ok", db: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      await expect(expectDbMode("http://nowhere", "live")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects when /health.db doesn't match expected", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "ok", db: "stub" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      await expect(
        expectDbMode("http://nowhere", "live"),
      ).rejects.toThrow(/Expected DB mode "live" but \/health reports "stub"/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects when /health returns non-200", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("oops", { status: 500 });
    try {
      await expect(expectDbMode("http://nowhere", "stub")).rejects.toThrow(
        /\/health returned 500/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd tests/e2e && bun run test helpers/dbmode.test.ts`

Expected: `Cannot find module './dbmode.js'` or similar.

- [ ] **Step 3: Implement the helper**

Create `tests/e2e/helpers/dbmode.ts`:

```ts
/**
 * Assert the running stack's API reports the expected DB mode.
 *
 * Catches profile drift loudly at setup time. If a test that should
 * run with `dev` somehow gets dispatched against `dev:fast`
 * (default-flip confusion, missing profile arg, env leak), this
 * fails the test's beforeAll with a clear message instead of letting
 * the test silently pass with stub data.
 *
 * Call AFTER lich up has returned and the api has responded to /health.
 * Pair with waitForHttp200(apiUrl + "/health") if needed.
 *
 * Expected modes:
 *   - "live": DATABASE_URL was set, sql client constructed, dev profile.
 *   - "stub": DATABASE_URL was empty, sql is null, dev:fast profile.
 */
export async function expectDbMode(
  apiUrl: string,
  expected: "live" | "stub",
): Promise<void> {
  const r = await fetch(`${apiUrl}/health`);
  if (!r.ok) {
    throw new Error(`/health returned ${r.status}; expected 200`);
  }
  const body = (await r.json()) as { status: string; db: "live" | "stub" };
  if (body.db !== expected) {
    throw new Error(
      `Expected DB mode "${expected}" but /health reports "${body.db}". ` +
        `Active profile may be wrong — did this test forget to pass "dev"?`,
    );
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd tests/e2e && bun run test helpers/dbmode.test.ts`

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/dbmode.ts tests/e2e/helpers/dbmode.test.ts
git commit -m "feat(tests): add expectDbMode helper

Per-test setup assertion that catches profile drift loudly. Tests
in the fast pool call expectDbMode(apiUrl, 'stub'); tests in the
compose pool call expectDbMode(apiUrl, 'live'). If the default
flip ever silently demotes a dev-test to dev:fast, this fails
the beforeAll with a clear message."
```

---

### Task 6: tests/e2e/_pool-manifest.ts — empty `COMPOSE_REQUIRED` array

**Files:**
- Create: `tests/e2e/_pool-manifest.ts`

- [ ] **Step 1: Create the manifest with an empty list**

Create `tests/e2e/_pool-manifest.ts`:

```ts
// Single source of truth for which e2e tests need the compose pool
// (singleFork, dev profile, real DB). Everything not listed here runs
// in the fast pool (parallel forks, dev:fast profile, no DB).
//
// Adding a new compose-requiring test:
//   1. Add the filename here (just the basename, e.g. "foo.test.ts").
//   2. In the test, call runLich(["up", "dev"], ...) — NOT runLich(["up"], ...).
//   3. In the test's beforeAll (after waitForHttp200 on /health), call
//      `await expectDbMode(apiUrl, "live");`.
//
// Target: ≤8 entries. If larger, the audit found a coverage pattern
// we didn't anticipate — document why in AUDIT.md.

export const COMPOSE_REQUIRED: readonly string[] = [
  // Filled in during per-test migration tasks (Phase B).
] as const;
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/_pool-manifest.ts
git commit -m "feat(tests): seed empty pool manifest for vitest dual-pool config

Per-test migration tasks (Phase B) populate COMPOSE_REQUIRED as
they classify each test."
```

---

### Task 7: tests/e2e/vitest.config.ts — dual-pool config

**Files:**
- Modify: `tests/e2e/vitest.config.ts`

- [ ] **Step 1: Read the current config**

Run: `cat tests/e2e/vitest.config.ts`

This should currently be the single-project config from `d957b17` (helpers/** is unexcluded; singleFork: true).

- [ ] **Step 2: Replace with dual-project config**

Overwrite `tests/e2e/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { COMPOSE_REQUIRED } from "./_pool-manifest.js";

const composeGlobs = COMPOSE_REQUIRED.map((f) => `**/${f}`);

// Two vitest projects:
//
//   - "fast"  : everything except COMPOSE_REQUIRED tests. Runs the
//               default dev:fast profile (no docker, no postgres).
//               Parallel forks (maxForks: 4) since tests don't share
//               docker state. Tighter timeouts — no compose excuse.
//
//   - "compose" : just the COMPOSE_REQUIRED tests. Runs the dev profile
//                 (with postgres). singleFork: true because all stacks
//                 share the host docker daemon and concurrent compose-ups
//                 would conflict on docker network/state. Larger timeouts
//                 to accommodate postgres healthcheck + after_up.
//
// See docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md
// for the full design.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "fast",
          include: ["**/*.test.ts"],
          exclude: ["node_modules/**", ...composeGlobs],
          pool: "forks",
          poolOptions: { forks: { singleFork: false, maxForks: 4 } },
          testTimeout: 30_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: "compose",
          include: composeGlobs.length > 0 ? composeGlobs : ["__no-files__"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
```

Note: when `COMPOSE_REQUIRED` is empty (Phase B not yet started), the compose project gets `["__no-files__"]` so vitest doesn't accidentally include all tests. After Phase B fills in the manifest, the array is non-empty and the placeholder is unused.

- [ ] **Step 3: Verify both projects load**

Run: `cd tests/e2e && bunx vitest list --project fast 2>&1 | tail -10`

Expected: lists all test files (the fast project picks up every `*.test.ts` since COMPOSE_REQUIRED is still empty).

Run: `cd tests/e2e && bunx vitest list --project compose 2>&1 | tail -5`

Expected: empty (compose project has no files yet, but doesn't error).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/vitest.config.ts
git commit -m "feat(tests): vitest dual-pool config (fast parallel, compose serial)

Fast project: parallel forks (maxForks: 4), tighter timeouts, excludes
COMPOSE_REQUIRED. Compose project: singleFork, larger timeouts,
includes only COMPOSE_REQUIRED.

Manifest is empty initially; per-test migration tasks (Phase B)
populate it. Compose project includes a __no-files__ placeholder
to make the include list non-empty during Phase A."
```

---

## PHASE B — TEST MIGRATION + HARDENING

### Migration Recipe (shared reference)

Each per-test task below applies one of two recipes. Determine which by reading the test:

**Fast recipe** (apply if the test does NOT assert on postgres-specific behavior, DATABASE_URL value, DB-backed routes, or migrations):

1. Confirm: test calls `runLich(["up"], { cwd: stackPath, env: { LICH_HOME: lichHome } })` (no explicit profile — default = dev:fast after Phase A).
2. Update assertions:
   - Service-name arrays: change `["api", "postgres", "tunnel_demo", "web"]` (or similar full set) to `["api", "web"]`.
   - `expectedKinds` maps (in dashboard tests): drop entries for `postgres` and `tunnel_demo`.
   - Any reference to `urls.postgres.host_port` or `services.postgres.*` env: remove (these don't exist under dev:fast).
3. Add `expectDbMode(apiUrl, "stub")` to beforeAll, after `waitForHttp200(apiUrl + "/health")`:
   ```ts
   import { expectDbMode } from "./helpers/dbmode.js";
   // ... in beforeAll:
   await waitForHttp200(`${apiUrl}/health`);
   await expectDbMode(apiUrl, "stub");
   ```
4. Hardening — read the test carefully. If you find any of these, fix in this same commit:
   - Magic `sleep(N)` or `setTimeout` for waiting on async state → replace with `waitForX(...)` helper from `tests/e2e/helpers/wait.ts`.
   - Polling loops without a deadline → add a deadline + error message including the last observed value.
   - Hard-coded ports or paths → use allocator output (`urls`) or `mkdtempSync`.
   - Weak assertions on `/api/things` — for fast tests, this route returns 503, so the test should NOT exercise it. Drop any `/api/things` calls if present.

**Compose recipe** (apply if the test asserts on postgres, DATABASE_URL value, DB-backed routes, or migrations):

1. Change `runLich(["up"], ...)` to `runLich(["up", "dev"], ...)` — explicit profile.
2. Keep service-name assertions as the full set (`["api", "postgres", "tunnel_demo", "web"]`).
3. Add `expectDbMode(apiUrl, "live")` to beforeAll, after `waitForHttp200(apiUrl + "/health")`:
   ```ts
   import { expectDbMode } from "./helpers/dbmode.js";
   // ... in beforeAll:
   await waitForHttp200(`${apiUrl}/health`);
   await expectDbMode(apiUrl, "live");
   ```
4. Append the test's filename to `COMPOSE_REQUIRED` in `tests/e2e/_pool-manifest.ts`:
   ```ts
   export const COMPOSE_REQUIRED: readonly string[] = [
     "<your-test-filename>.test.ts",
     // ... others ...
   ] as const;
   ```
5. Hardening:
   - Magic sleeps, polling without deadlines, hard-coded ports/paths → same as fast recipe.
   - Strengthen weak `/api/things` assertions — if the test calls `/api/things`, assert on actual content (`expect(things[0].name).toBe("first thing")` or `expect(things).toHaveLength(3)`), NOT just shape (`expect(Array.isArray(things))`).
   - Row-count assertions on `things`: with tmpfs (Task 3), data is fresh per up. Use `== 3` not `>= 3` if the test relies on the seed-only state.

**Commit message template:**

```
test: migrate <filename> to <fast|compose> pool

<one-line description of substantive change beyond mechanical migration,
e.g. "tightened /api/things content assertion from shape to value" or
"replaced 2s magic sleep with waitForReadyState helper">
```

Verification per task: `cd tests/e2e && bunx vitest --project <fast|compose> run <filename>.test.ts`

Pre-classification (subagents should confirm by reading each file, but these are the expected buckets):

**Fast pool (24 tests):** basic-up, restart-basic, logs, exec, friendly-urls, down, capture-log-value, commands-user-defined, daemon-auto-start, daemon-auto-shutdown, dashboard-failed-service, dashboard-parallel-stacks, dashboard-stack-detail, dashboard-stack-list, dashboard-stop-action, failure-fail-when, failure-port-already-in-use, failure-process-exit, failure-ready-timeout, parallel-stacks, profiles-default, profiles-named, profiles-switch-refused, profiles-lich-profile-env

**Compose pool (5 tests):** profiles-lifecycle-scoping, env-dotenv, profiles-env-override, env-groups-isolation, lifecycle-env-group

**No migration needed (4 tests — don't run `lich up`):** help, failure-validate-bad-regex, profiles-validate-errors, validate-plan2-errors

Total tasks: 24 + 5 = 29 per-test migrations.

---

### Tasks 8-31 — Fast-pool migrations (24 tasks)

Each task below: apply the Fast recipe above to one test file. Subagent confirms classification by reading the test first. If they find the test should actually be in the compose pool, they file a note in the commit message and use the Compose recipe instead.

#### Task 8: Migrate `tests/e2e/basic-up.test.ts`

**Files:** Modify `tests/e2e/basic-up.test.ts`. Specific assertions to update:
- Service-name array around line ~310 (currently `["api", "postgres", "tunnel_demo", "web"]`).
- `parseLichUrls` consumers expect `urls.api`, `urls.web`; drop the `urls.postgres` block if present.

- [ ] **Step 1: Read the test and confirm Fast classification**

Run: `cat tests/e2e/basic-up.test.ts | head -100; grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/basic-up.test.ts`

Confirm: no DATABASE_URL value assertion, no postgres-specific behavior assertion, no /api/things call. Classification: fast.

- [ ] **Step 2: Apply Fast recipe**

Apply migration recipe (Phase B header). Specifics for this file:
- Change service-name array `["api", "postgres", "tunnel_demo", "web"]` → `["api", "web"]`.
- Drop the postgres TCP-probe block (added during LEV-463).
- Add `expectDbMode` import + call in beforeAll.

- [ ] **Step 3: Run the test in the fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run basic-up.test.ts`

Expected: pass, runtime <15s.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/basic-up.test.ts
git commit -m "test: migrate basic-up.test.ts to fast pool"
```

---

#### Task 9: Migrate `tests/e2e/restart-basic.test.ts`

**Files:** Modify `tests/e2e/restart-basic.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/restart-basic.test.ts`

Confirm: no DB-specific assertions.

- [ ] **Step 2: Apply Fast recipe**

Service-name array updates + `expectDbMode("stub")` in beforeAll. Strengthen any weak assertions per the recipe.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run restart-basic.test.ts`

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/restart-basic.test.ts
git commit -m "test: migrate restart-basic.test.ts to fast pool"
```

---

#### Task 10: Migrate `tests/e2e/logs.test.ts`

**Files:** Modify `tests/e2e/logs.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/logs.test.ts`

- [ ] **Step 2: Apply Fast recipe**

Service-name updates + `expectDbMode("stub")`.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run logs.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/logs.test.ts
git commit -m "test: migrate logs.test.ts to fast pool"
```

---

#### Task 11: Migrate `tests/e2e/exec.test.ts`

**Files:** Modify `tests/e2e/exec.test.ts`.

- [ ] **Step 1: Read + confirm classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things|psql' tests/e2e/exec.test.ts`

Note: if the test uses `lich exec -- psql`, it needs DB → upgrade to Compose. Confirm by reading the test body.

- [ ] **Step 2: Apply appropriate recipe**

If Fast: Service-name updates + `expectDbMode("stub")`.
If Compose: Add `"dev"` arg, `expectDbMode("live")`, add filename to manifest.

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run exec.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/exec.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate exec.test.ts to <fast|compose> pool"
```

(Stage `_pool-manifest.ts` only if you added the file to it.)

---

#### Task 12: Migrate `tests/e2e/friendly-urls.test.ts`

**Files:** Modify `tests/e2e/friendly-urls.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/friendly-urls.test.ts`

- [ ] **Step 2: Apply Fast recipe**

Service-name updates + `expectDbMode("stub")`. friendly-urls likely tests the URL transformation — service list is incidental.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run friendly-urls.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/friendly-urls.test.ts
git commit -m "test: migrate friendly-urls.test.ts to fast pool"
```

---

#### Task 13: Migrate `tests/e2e/down.test.ts`

**Files:** Modify `tests/e2e/down.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/down.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run down.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/down.test.ts
git commit -m "test: migrate down.test.ts to fast pool"
```

---

#### Task 14: Migrate `tests/e2e/capture-log-value.test.ts`

**Files:** Modify `tests/e2e/capture-log-value.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/capture-log-value.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run capture-log-value.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/capture-log-value.test.ts
git commit -m "test: migrate capture-log-value.test.ts to fast pool"
```

---

#### Task 15: Migrate `tests/e2e/commands-user-defined.test.ts`

**Files:** Modify `tests/e2e/commands-user-defined.test.ts`.

- [ ] **Step 1: Read + confirm classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things|psql' tests/e2e/commands-user-defined.test.ts`

Note: if the test exercises a user-defined `db:psql` command, it needs DB → Compose.

- [ ] **Step 2: Apply appropriate recipe**

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run commands-user-defined.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/commands-user-defined.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate commands-user-defined.test.ts to <fast|compose> pool"
```

---

#### Task 16: Migrate `tests/e2e/daemon-auto-start.test.ts`

**Files:** Modify `tests/e2e/daemon-auto-start.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/daemon-auto-start.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run daemon-auto-start.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/daemon-auto-start.test.ts
git commit -m "test: migrate daemon-auto-start.test.ts to fast pool"
```

---

#### Task 17: Migrate `tests/e2e/daemon-auto-shutdown.test.ts`

**Files:** Modify `tests/e2e/daemon-auto-shutdown.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/daemon-auto-shutdown.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run daemon-auto-shutdown.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/daemon-auto-shutdown.test.ts
git commit -m "test: migrate daemon-auto-shutdown.test.ts to fast pool"
```

---

#### Task 18: Migrate `tests/e2e/dashboard-failed-service.test.ts`

**Files:** Modify `tests/e2e/dashboard-failed-service.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/dashboard-failed-service.test.ts`

- [ ] **Step 2: Apply Fast recipe**

Service-name updates including the `expectedKinds` map (drop `postgres: "compose"`, `tunnel_demo: "owned"`). The test should provoke a failure in the api/web — that's intact in dev:fast.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run dashboard-failed-service.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-failed-service.test.ts
git commit -m "test: migrate dashboard-failed-service.test.ts to fast pool"
```

---

#### Task 19: Migrate `tests/e2e/dashboard-parallel-stacks.test.ts`

**Files:** Modify `tests/e2e/dashboard-parallel-stacks.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/dashboard-parallel-stacks.test.ts`

This test sets up two parallel stacks. Confirm both are intended as default-profile stacks (not one fast + one compose).

- [ ] **Step 2: Apply Fast recipe**

PRESERVE the LEV-466 polling loop at ~lines 581-617. The polling loop is correct and necessary; just adapt the service-name expectations around it.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run dashboard-parallel-stacks.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-parallel-stacks.test.ts
git commit -m "test: migrate dashboard-parallel-stacks.test.ts to fast pool"
```

---

#### Task 20: Migrate `tests/e2e/dashboard-stack-detail.test.ts`

**Files:** Modify `tests/e2e/dashboard-stack-detail.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/dashboard-stack-detail.test.ts`

- [ ] **Step 2: Apply Fast recipe**

Update `expectedKinds` map (drop postgres + tunnel_demo entries).

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run dashboard-stack-detail.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-stack-detail.test.ts
git commit -m "test: migrate dashboard-stack-detail.test.ts to fast pool"
```

---

#### Task 21: Migrate `tests/e2e/dashboard-stack-list.test.ts`

**Files:** Modify `tests/e2e/dashboard-stack-list.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/dashboard-stack-list.test.ts`

- [ ] **Step 2: Apply Fast recipe**

Update `expectedKinds` map.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run dashboard-stack-list.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-stack-list.test.ts
git commit -m "test: migrate dashboard-stack-list.test.ts to fast pool"
```

---

#### Task 22: Migrate `tests/e2e/dashboard-stop-action.test.ts`

**Files:** Modify `tests/e2e/dashboard-stop-action.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/dashboard-stop-action.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run dashboard-stop-action.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-stop-action.test.ts
git commit -m "test: migrate dashboard-stop-action.test.ts to fast pool"
```

---

#### Task 23: Migrate `tests/e2e/failure-fail-when.test.ts`

**Files:** Modify `tests/e2e/failure-fail-when.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/failure-fail-when.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run failure-fail-when.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/failure-fail-when.test.ts
git commit -m "test: migrate failure-fail-when.test.ts to fast pool"
```

---

#### Task 24: Migrate `tests/e2e/failure-port-already-in-use.test.ts`

**Files:** Modify `tests/e2e/failure-port-already-in-use.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/failure-port-already-in-use.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run failure-port-already-in-use.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/failure-port-already-in-use.test.ts
git commit -m "test: migrate failure-port-already-in-use.test.ts to fast pool"
```

---

#### Task 25: Migrate `tests/e2e/failure-process-exit.test.ts`

**Files:** Modify `tests/e2e/failure-process-exit.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/failure-process-exit.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run failure-process-exit.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/failure-process-exit.test.ts
git commit -m "test: migrate failure-process-exit.test.ts to fast pool"
```

---

#### Task 26: Migrate `tests/e2e/failure-ready-timeout.test.ts`

**Files:** Modify `tests/e2e/failure-ready-timeout.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/failure-ready-timeout.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run failure-ready-timeout.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/failure-ready-timeout.test.ts
git commit -m "test: migrate failure-ready-timeout.test.ts to fast pool"
```

---

#### Task 27: Migrate `tests/e2e/parallel-stacks.test.ts`

**Files:** Modify `tests/e2e/parallel-stacks.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/parallel-stacks.test.ts`

- [ ] **Step 2: Apply Fast recipe**

This test runs two stacks in distinct worktrees. Both should use the fast profile.

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run parallel-stacks.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/parallel-stacks.test.ts
git commit -m "test: migrate parallel-stacks.test.ts to fast pool"
```

---

#### Task 28: Migrate `tests/e2e/profiles-default.test.ts`

**Files:** Modify `tests/e2e/profiles-default.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/profiles-default.test.ts`

This test asserts on default-profile behavior. With Phase A's flip, the default is now `dev:fast` — update the assertion accordingly (expected profile name + service list).

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run profiles-default.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-default.test.ts
git commit -m "test: migrate profiles-default.test.ts to fast pool

Asserts on default profile, which flipped from 'dev' to 'dev:fast'
in Phase A. Test now expects dev:fast service list and DATABASE_URL
absent."
```

---

#### Task 29: Migrate `tests/e2e/profiles-named.test.ts`

**Files:** Modify `tests/e2e/profiles-named.test.ts`.

- [ ] **Step 1: Read + confirm classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/profiles-named.test.ts`

If the test asserts on DATABASE_URL value, it's Compose. Confirm by reading.

- [ ] **Step 2: Apply appropriate recipe**

If Fast: assertions update. If Compose: add `"dev"` arg + manifest entry.

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run profiles-named.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-named.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate profiles-named.test.ts to <fast|compose> pool"
```

---

#### Task 30: Migrate `tests/e2e/profiles-switch-refused.test.ts`

**Files:** Modify `tests/e2e/profiles-switch-refused.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/profiles-switch-refused.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run profiles-switch-refused.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-switch-refused.test.ts
git commit -m "test: migrate profiles-switch-refused.test.ts to fast pool"
```

---

#### Task 31: Migrate `tests/e2e/profiles-lich-profile-env.test.ts`

**Files:** Modify `tests/e2e/profiles-lich-profile-env.test.ts`.

- [ ] **Step 1: Read + confirm Fast classification**

Run: `grep -nE 'postgres|DATABASE_URL|api/things' tests/e2e/profiles-lich-profile-env.test.ts`

- [ ] **Step 2: Apply Fast recipe**

- [ ] **Step 3: Run in fast pool**

Run: `cd tests/e2e && bunx vitest --project fast run profiles-lich-profile-env.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-lich-profile-env.test.ts
git commit -m "test: migrate profiles-lich-profile-env.test.ts to fast pool"
```

---

### Tasks 32-36 — Compose-pool migrations (5 tasks)

#### Task 32: Migrate `tests/e2e/profiles-lifecycle-scoping.test.ts` (compose)

**Files:** Modify `tests/e2e/profiles-lifecycle-scoping.test.ts` AND `tests/e2e/_pool-manifest.ts`.

- [ ] **Step 1: Confirm Compose classification**

Run: `grep -nE 'count\(\*\)|things|psql|DATABASE_URL' tests/e2e/profiles-lifecycle-scoping.test.ts`

Confirms the test exercises postgres migrations + counts seed rows. Compose pool.

- [ ] **Step 2: Apply Compose recipe**

- Add `"dev"` arg: `runLich(["up", "dev"], ...)`.
- Add `expectDbMode(apiUrl, "live")` to beforeAll.
- With tmpfs (Task 3), data is fresh per up — change any `>= 3` to `== 3` for the seed count.
- Append `"profiles-lifecycle-scoping.test.ts"` to `COMPOSE_REQUIRED` in `_pool-manifest.ts`.

- [ ] **Step 3: Run in compose pool**

Run: `cd tests/e2e && bunx vitest --project compose run profiles-lifecycle-scoping.test.ts`

Expected: pass; psql count returns 3.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-lifecycle-scoping.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate profiles-lifecycle-scoping.test.ts to compose pool

Asserts on psql count of seeded things. Compose pool needed for
postgres + after_up migrations. With tmpfs (Task 3) the data is
fresh per up cycle — assertion tightened from >= 3 to == 3."
```

---

#### Task 33: Migrate `tests/e2e/env-dotenv.test.ts` (compose)

**Files:** Modify `tests/e2e/env-dotenv.test.ts` AND `tests/e2e/_pool-manifest.ts`.

- [ ] **Step 1: Confirm classification**

Run: `grep -nE 'DATABASE_URL|postgres' tests/e2e/env-dotenv.test.ts`

If the test asserts on DATABASE_URL's resolved value (which only exists under dev), classification is Compose. Otherwise Fast — confirm by reading.

- [ ] **Step 2: Apply appropriate recipe**

Compose if DATABASE_URL assertion present. Add to manifest if Compose.

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run env-dotenv.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/env-dotenv.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate env-dotenv.test.ts to <fast|compose> pool"
```

---

#### Task 34: Migrate `tests/e2e/profiles-env-override.test.ts` (compose)

**Files:** Modify `tests/e2e/profiles-env-override.test.ts` AND `tests/e2e/_pool-manifest.ts`.

- [ ] **Step 1: Confirm Compose classification**

Run: `grep -nE 'DATABASE_URL|env-override|dev:env-override' tests/e2e/profiles-env-override.test.ts`

This test exercises the dev:env-override profile, which extends dev. Compose pool needed.

- [ ] **Step 2: Apply Compose recipe**

`runLich(["up", "dev:env-override"], ...)` (not just "dev"). Add to manifest.

- [ ] **Step 3: Run in compose pool**

Run: `cd tests/e2e && bunx vitest --project compose run profiles-env-override.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/profiles-env-override.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate profiles-env-override.test.ts to compose pool

Uses dev:env-override profile (extends dev). Compose pool required
for the postgres-backed env resolution path. expectDbMode is
'live' since dev:env-override inherits dev's services."
```

---

#### Task 35: Migrate `tests/e2e/env-groups-isolation.test.ts`

**Files:** Modify `tests/e2e/env-groups-isolation.test.ts` AND (if Compose) `tests/e2e/_pool-manifest.ts`.

- [ ] **Step 1: Confirm classification**

Run: `grep -nE 'DATABASE_URL|postgres|env_group' tests/e2e/env-groups-isolation.test.ts`

If it tests env_group isolation independent of DB, it's Fast. If it asserts on a postgres-derived env value, it's Compose.

- [ ] **Step 2: Apply appropriate recipe**

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run env-groups-isolation.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/env-groups-isolation.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate env-groups-isolation.test.ts to <fast|compose> pool"
```

---

#### Task 36: Migrate `tests/e2e/lifecycle-env-group.test.ts`

**Files:** Modify `tests/e2e/lifecycle-env-group.test.ts` AND (if Compose) `tests/e2e/_pool-manifest.ts`.

- [ ] **Step 1: Confirm classification**

Run: `grep -nE 'DATABASE_URL|postgres|lifecycle' tests/e2e/lifecycle-env-group.test.ts`

If it tests lifecycle hooks that use DB → Compose. Otherwise Fast.

- [ ] **Step 2: Apply appropriate recipe**

- [ ] **Step 3: Run in chosen pool**

Run: `cd tests/e2e && bunx vitest --project <fast|compose> run lifecycle-env-group.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/lifecycle-env-group.test.ts tests/e2e/_pool-manifest.ts
git commit -m "test: migrate lifecycle-env-group.test.ts to <fast|compose> pool"
```

---

## PHASE C — AUDIT DOC + VERIFICATION (Tasks 37-39)

### Task 37: Compile `tests/e2e/AUDIT.md`

**Files:** Create `tests/e2e/AUDIT.md`.

- [ ] **Step 1: Gather migration commits**

Run: `git log --oneline --grep="^test: migrate" -- tests/e2e/`

Expected: ~29 commits, one per migrated test.

- [ ] **Step 2: Build the audit table**

Create `tests/e2e/AUDIT.md` with this structure (one row per migrated test):

```markdown
# E2E test suite audit

Compiled during the Solid + Fast migration — see
`docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md`
and `docs/superpowers/plans/2026-05-25-e2e-suite-solid-and-fast.md`.

Each row captures:
- **Test file**: basename under tests/e2e/
- **Pool**: fast (parallel forks, dev:fast profile) or compose
  (singleFork, dev profile)
- **Primary assertion**: one-line description of what the test
  guarantees
- **Race risks identified**: what could flake; "none" if audit
  found nothing
- **Hardening applied**: per-test hardening landed in the
  migration commit (helper substitution, assertion tightening,
  etc.); "none" if migration was purely mechanical

For each row, populate from the migration commit's diff and
commit message body. The git log entry has the rationale.

| Test file | Pool | Primary assertion | Race risks | Hardening applied |
|---|---|---|---|---|
| basic-up.test.ts | fast | lich up brings api+web up; urls list correct; /health responds | (fill from commit) | (fill from commit) |
| restart-basic.test.ts | fast | (fill) | (fill) | (fill) |
| ... | ... | ... | ... | ... |
```

Walk every `tests/e2e/*.test.ts` file and:
- Read the test's top-of-file header comment to extract the primary assertion.
- Read the corresponding migration commit (`git log -1 --grep="migrate <filename>"`) for hardening notes.
- Fill in the table row.

For tests that did NOT need migration (help, failure-validate-bad-regex, profiles-validate-errors, validate-plan2-errors), include them with pool="fast (no setup)" and note "validate-only, no lich up".

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/AUDIT.md
git commit -m "docs(tests): compile e2e suite audit table

One row per test: pool assignment, primary assertion, race risks
identified during audit, hardening applied. Sources from the
per-test migration commits — future readers grep
'git log -- <test>' for the rationale per file."
```

---

### Task 38: Full-suite verification + measure

**Files:** none (verification only).

- [ ] **Step 1: Build the binary**

Run: `cd packages/lich && bun run build`

- [ ] **Step 2: Clean docker state**

Run: `docker ps -aq --filter "label=com.docker.compose.project" | xargs -r docker rm -f 2>/dev/null; docker volume prune -f 2>/dev/null`

- [ ] **Step 3: Run the fast pool alone, timed**

Run: `cd tests/e2e && time bunx vitest --project fast run 2>&1 | tail -15`

Expected: all fast-pool tests pass. Note the elapsed time.

- [ ] **Step 4: Run the compose pool alone, timed**

Run: `cd tests/e2e && time bunx vitest --project compose run 2>&1 | tail -15`

Expected: all compose-pool tests pass. Note the elapsed time.

- [ ] **Step 5: Run the full suite, timed**

Run: `cd tests/e2e && time bun run test 2>&1 | tail -20`

Expected: 0 failures. Total elapsed time should be approximately the max of (fast + compose) since they could run sequentially within vitest. Target: <3 min warm, <5 min cold.

- [ ] **Step 6: Verify acceptance criteria**

Check each criterion from the spec's Section 7 (`docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md`):

```bash
# All tests pass
bun run test  # exit 0

# dev:fast is default
grep -A2 "dev:fast:" examples/dogfood-stack/lich.yaml | grep "default: true"

# every test has expectDbMode (excluding validate-only tests)
grep -c "expectDbMode" tests/e2e/*.test.ts | grep -v ":0"

# COMPOSE_REQUIRED ≤8
grep -c '".*\.test\.ts"' tests/e2e/_pool-manifest.ts

# AUDIT.md exists
ls tests/e2e/AUDIT.md

# /health contract
LICH=$PWD/packages/lich/dist/lich
mkdir -p /tmp/lich-accept
LICH_HOME=/tmp/lich-accept $LICH up --cwd examples/dogfood-stack --no-browser
curl -s http://api.<wt>.lich.localhost:3300/health  # expect db: stub
LICH_HOME=/tmp/lich-accept $LICH down --yes --cwd examples/dogfood-stack
LICH_HOME=/tmp/lich-accept $LICH up dev --cwd examples/dogfood-stack --no-browser
curl -s http://api.<wt>.lich.localhost:3300/health  # expect db: live
curl -s http://api.<wt>.lich.localhost:3300/api/things  # expect 200 + array
LICH_HOME=/tmp/lich-accept $LICH down --yes --cwd examples/dogfood-stack
rm -rf /tmp/lich-accept

# Daemon shutdown clean
LICH_HOME=/tmp/lich-shutdown $LICH up --cwd examples/dogfood-stack --no-browser
LICH_HOME=/tmp/lich-shutdown $LICH nuke --yes
ps aux | grep -E 'lich-daemon|lich up' | grep -v grep  # expect: no output
rm -rf /tmp/lich-shutdown

# Postgres tmpfs ephemeral
LICH_HOME=/tmp/lich-tmpfs $LICH up dev --cwd examples/dogfood-stack --no-browser
LICH_HOME=/tmp/lich-tmpfs $LICH exec --cwd examples/dogfood-stack -- sh -c 'psql "$DATABASE_URL" -tAc "select count(*) from things"'  # expect: 3
LICH_HOME=/tmp/lich-tmpfs $LICH exec --cwd examples/dogfood-stack -- sh -c 'psql "$DATABASE_URL" -tAc "insert into things(name) values (\$\$leak\$\$)"'
LICH_HOME=/tmp/lich-tmpfs $LICH down --yes --cwd examples/dogfood-stack
LICH_HOME=/tmp/lich-tmpfs $LICH up dev --cwd examples/dogfood-stack --no-browser
LICH_HOME=/tmp/lich-tmpfs $LICH exec --cwd examples/dogfood-stack -- sh -c 'psql "$DATABASE_URL" -tAc "select count(*) from things"'  # expect: 3 (NOT 4 — tmpfs ephemeral)
LICH_HOME=/tmp/lich-tmpfs $LICH down --yes --cwd examples/dogfood-stack
rm -rf /tmp/lich-tmpfs
```

Expected: all assertions hold. If wall-clock target missed, document why in AUDIT.md but don't block.

- [ ] **Step 7: Commit verification notes if any fixups happened**

If Step 6 surfaced an issue and you fixed it inline (e.g., a flaky test that needed one more wait helper), commit that fix with a descriptive message. Otherwise, no commit.

---

### Task 39: Mark spec as Implemented, comment Linear

**Files:**
- Modify: `docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md` (header)

- [ ] **Step 1: Update spec header**

Edit the top of `docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md`. Change:

```markdown
> **Status:** Approved. Implementation plan to follow via `writing-plans`.
```

to:

```markdown
> **Status:** Implemented. See `docs/superpowers/plans/2026-05-25-e2e-suite-solid-and-fast.md`.
```

- [ ] **Step 2: Commit the status update**

```bash
git add docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md
git commit -m "docs(spec): mark e2e suite solid+fast design as Implemented"
```

- [ ] **Step 3: (Manual) Update Linear**

The orchestrator (not a subagent) should:
- Mark this plan's tracking issue Done in Linear (if a tracking issue was created).
- Comment on LEV-468 through LEV-476 (Phase 3 expansion tasks): "Phase 3 unblocked — e2e suite is now fast + solid (plan 2026-05-25-e2e-suite-solid-and-fast.md). Resume as a new wave."

---

## Self-review summary

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| API code (db.ts + index.ts tolerance/503/health-mode) | Tasks 1, 2 |
| Profile yaml (dev:fast + default flip) | Task 4 |
| Postgres tmpfs | Task 3 |
| `expectDbMode` helper | Task 5 |
| `_pool-manifest.ts` | Task 6 (initial) + per-test compose tasks (population) |
| `vitest.config.ts` dual-pool | Task 7 |
| Per-test migration (fast) | Tasks 8-31 |
| Per-test migration (compose) | Tasks 32-36 |
| Validate-only tests (no migration) | Documented in Task 37 AUDIT.md inclusion |
| `AUDIT.md` | Task 37 |
| Acceptance criteria | Task 38 |
| Spec status update | Task 39 |

**Placeholder scan:** Per-test tasks use parameterized commit messages (e.g., `<fast|compose>`) because the classification is the agent's call after reading the file. The classification rule is fully specified in the Migration Recipe — not a hidden TBD. Verification commands are concrete; assertion changes are described concretely per the recipe.

**Type consistency:** `dbAvailable()` is exported from `db.ts` (Task 1), imported by `index.ts` (Task 2), and used to gate `/api/things`. `expectDbMode(apiUrl, "live" | "stub")` signature is consistent across the helper (Task 5) and every per-test consumer. `COMPOSE_REQUIRED` is `readonly string[]` consistently across Tasks 6, 7, and the per-test compose tasks. Vitest project names (`fast`, `compose`) are consistent across Tasks 7 and the per-test verification commands.

---
