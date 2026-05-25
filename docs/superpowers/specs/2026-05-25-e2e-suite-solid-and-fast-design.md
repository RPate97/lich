# E2E Suite: Solid + Fast — Design

> **Status:** Approved. Implementation plan to follow via `writing-plans`.
>
> **Related:** Pauses Phase 3 of `2026-05-25-dogfood-stack-redesign-and-expansion.md` (coverage expansion). Phase 3 resumes once this design ships.
>
> **Scope:** The lich v1 e2e test suite under `tests/e2e/` and the dogfood-stack at `examples/dogfood-stack/`. Does NOT touch the lich engine itself.

## Goal

Make the existing e2e suite **fast** (target: wall-clock under 3 min warm / 5 min cold, down from ~28 min pre-Phase-1) and **solid** (no silent coverage loss, no race-flakes, every test's contract explicit). Adds no new product features; reshapes the test harness around them.

## Strategy

Three independent but coordinated changes:

1. **`dev:fast` profile** — a no-compose variant of the dogfood stack that runs only the owned services (api + web). Becomes the default profile. Tests that don't need a database run against this, dropping ~3-5s of compose startup per test.

2. **API code: postgres-tolerant with explicit DB-mode signal** — the api gracefully refuses (503) DB-backed routes when `DATABASE_URL` is empty, and reports `db: "live" | "stub"` on `/health`. Combined with a test setup helper, this surfaces silent profile drift loudly.

3. **Vitest dual-pool config** — `fast` project (parallel forks) for tests that don't need compose; `compose` project (singleFork) for the small set that does. Up to 4x speedup on the fast subset on top of the per-test savings.

A flakiness audit runs in parallel with the migration: each test's assertions, race risks, and hardening get captured in an `AUDIT.md` deliverable so we can see at a glance what each test guarantees.

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  examples/dogfood-stack/lich.yaml                                 │
│  ┌────────────────────┐   ┌──────────────────────────────────┐    │
│  │ profile: dev:fast  │   │ profile: dev                     │    │
│  │   default: true    │   │   (no longer default)            │    │
│  │   services: []     │   │   services: [postgres]           │    │
│  │   owned: [api,web] │   │   owned: [api,web,tunnel_demo]   │    │
│  │   (no migrations)  │   │   after_up: [psql migrate+seed]  │    │
│  └────────────────────┘   └──────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────────┐   ┌───────────────────────────────┐
│ apps/api (DB-tolerant)      │   │ tests/e2e/vitest.config.ts    │
│  /health → {                │   │  projects:                    │
│    status: "ok",            │   │   - "fast" (default)          │
│    db: "live" | "stub"      │   │       pool: forks, parallel   │
│  }                          │   │       exclude: COMPOSE_REQUIRED│
│  /api/things                │   │   - "compose"                 │
│    if !DATABASE_URL → 503   │   │       pool: forks, singleFork │
│    else pg query, 500 on err│   │       include: COMPOSE_REQUIRED│
└─────────────────────────────┘   └───────────────────────────────┘
                                          ▲
                                          │
                          ┌───────────────┴───────────────────┐
                          │ tests/e2e/_pool-manifest.ts       │
                          │   export const COMPOSE_REQUIRED   │
                          │     = ["profiles-lifecycle-...",  │
                          │        "env-dotenv...",  ...]     │
                          └───────────────────────────────────┘
```

## Components

### 1. API code: strict + DB-mode signal

`apps/api/src/db.ts` already migrated to `Bun.sql` by LEV-463. Update to gate construction on `DATABASE_URL` presence:

```ts
import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL ?? "";

// Gracefully tolerate the dev:fast profile, which intentionally doesn't
// run postgres. Tests that don't exercise DB-backed routes never notice;
// routes that do explicitly check `dbAvailable()` first and return 503
// (caught by callers, not silent).
export const sql = databaseUrl.length > 0 ? new SQL(databaseUrl) : null;

export function dbAvailable(): boolean {
  return sql !== null;
}
```

`apps/api/src/index.ts`:

```ts
import { dbAvailable, sql } from "./db.js";

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
    const rows = await sql!`select id, name from things order by id`;
    res.json(rows);
  } catch (err) {
    console.error("[api] postgres error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

### 2. Test setup helper: `expectDbMode`

New helper at `tests/e2e/helpers/dbmode.ts`:

```ts
/**
 * Assert the running stack's API reports the expected DB mode. Catches
 * profile drift — if a test that should run with `dev` somehow gets
 * dispatched against `dev:fast` (default-flip confusion, missing
 * profile arg), this fails loudly at setup time instead of silently
 * passing with stub data.
 *
 * Call from beforeAll AFTER lich up has returned and the api has
 * responded to /health. Pair with waitForHttp200 if needed.
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

Every e2e test's `beforeAll` calls it after `lich up`. The audit phase enforces this — grep across `tests/e2e/*.test.ts` must show one `expectDbMode(...)` per test.

### 3. Profile yaml

`examples/dogfood-stack/lich.yaml`:

```yaml
profiles:
  dev:fast:
    default: true
    services: []
    owned: [api, web]
    # No after_up — no DB to migrate.

  dev:
    services: [postgres]
    owned: [api, web, tunnel_demo]
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed.sql

  dev:env-override:
    extends: dev
    env:
      DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/dogfood"
```

`tunnel_demo` stays only in `dev` — cheap (~1s) but adds no value to fast tests. Revisit if a fast test needs capture-pipeline coverage.

### 4. Test classification — central manifest

`tests/e2e/_pool-manifest.ts`:

```ts
// Single source of truth for which e2e tests need the compose pool
// (singleFork, dev profile, real DB). Everything not listed here runs
// in the fast pool (parallel forks, dev:fast profile, no DB).
//
// Adding a new compose-requiring test? Add the filename here AND have
// its beforeAll call expectDbMode(apiUrl, "live").

export const COMPOSE_REQUIRED: readonly string[] = [
  // Filled in during the audit phase. Examples of what likely ends up here:
  // - profiles-lifecycle-scoping.test.ts (psql count(*))
  // - env-dotenv.test.ts (DATABASE_URL value)
  // - profiles-env-override.test.ts (DATABASE_URL override)
] as const;
```

Target: ≤8 files. Stretch goal: ≤5. If larger, the audit found a coverage pattern we didn't anticipate — document why in AUDIT.md.

### 5. Vitest dual-pool

`tests/e2e/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { COMPOSE_REQUIRED } from "./_pool-manifest.js";

const composeGlobs = COMPOSE_REQUIRED.map((f) => `**/${f}`);

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
          include: composeGlobs,
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

Isolation guarantees the parallel pool needs (all already true today, verified during audit):
- Each test has its own `LICH_HOME` (`makeFixture()`)
- Each test has its own tmpdir (`copyExampleToTmpdir()`)
- Lich's port allocator gives unique ports per stack invocation
- No tests share filesystem state outside their tmpdir

If audit finds a violation of the last point, the test gets refactored or moved to `compose`.

### 6. Migration mechanics

Per-test, one commit each:

**Fast-eligible** (default, most tests):
- No profile arg change (test calls `runLich(["up"], ...)`; default = `dev:fast` after flip)
- Update assertions to expect `[api, web]` not `[api, postgres, tunnel_demo, web]`
- Add `expectDbMode(apiUrl, "stub")` after `waitForHttp200("/health")`
- Strengthen any weak assertions identified in audit
- Replace magic sleeps with `waitForX` helpers

**Compose-required** (~5-8 tests):
- Add explicit `"dev"` argument: `runLich(["up", "dev"], ...)`
- Leave service-list assertions as-is (full set with postgres)
- Add `expectDbMode(apiUrl, "live")` after setup
- Append filename to `COMPOSE_REQUIRED`
- Strengthen weak assertions on `/api/things` (assert content, not just shape)

### 7. Audit deliverable

`tests/e2e/AUDIT.md` — one row per test:

| Test file | Pool | Primary assertion | Race risks | Hardening applied |
|---|---|---|---|---|
| `basic-up.test.ts` | fast | api+web come up; urls list; /health 200 | next dev cold start sometimes >5s | `waitForHttp200` timeout raised; comment cites |
| `profiles-lifecycle-scoping.test.ts` | compose | psql `count(*) == 3` from things | none (tmpfs ensures fresh DB per up/down) | assertion tightened from `>= 3` to `== 3`; comment cites tmpfs |
| ... | ... | ... | ... | ... |

In-place audit — each test migrated AND hardened in the same commit. No separate audit-then-harden pass.

### 8. Postgres on tmpfs (ephemeral per up/down cycle)

`examples/dogfood-stack/compose.yaml`'s `postgres` service mounts a `tmpfs` for the data directory:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    tmpfs:
      - /var/lib/postgresql/data
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: dogfood
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d dogfood"]
      interval: 1s
      timeout: 1s
      retries: 30
```

Two wins:

- **Ephemeral data per `lich down → lich up` cycle.** The default anonymous-volume behavior persists data across `lich down`, which forced tests to use `>=` instead of `==` for row-count assertions (LEV-463 finding). With `tmpfs`, every fresh container starts empty; the `after_up` migration + seed produces the canonical 3 rows; tests can assert `== 3` again.
- **Faster I/O.** Data lives in RAM rather than on a copy-on-write disk volume. `pg_isready` healthcheck should land sub-second. Negligible per test, meaningful across the suite.

Caveats:

- Data still persists within a single `lich up` session (the container is alive the whole time). Only down → up cycles get a clean slate. This is the correct semantic for tests.
- macOS users (Docker Desktop / OrbStack): both run a Linux VM where `tmpfs` works. No platform-specific workaround needed.
- A user playing with the dogfood-stack as a personal DB would lose data on every `lich down`. Acceptable for an example/demo app; if anyone wants persistent dev data they can run their own postgres or remove the tmpfs mount.
- The tmpfs lives in `compose.yaml` (not inline in `lich.yaml`) because of LEV-477 — lich's compose override generator currently drops non-port/env passthrough fields. Once LEV-477 ships, the whole `services.postgres` block can move back inline.

## Acceptance criteria

All of these must hold on a fresh checkout for the plan to be considered done:

| Criterion | How verified |
|---|---|
| All e2e tests pass | `bun run test` exits 0; both `fast` and `compose` projects green |
| Suite wall-clock under 3 min (warm) / 5 min (cold) | Time `bun run test` on a clean clone with docker pre-pulled |
| `dev:fast` is the default profile | `lich up` with no args resolves to `dev:fast` (verify via `lich status` or yaml inspection) |
| Every test has `expectDbMode(...)` in setup | `grep -c "expectDbMode" tests/e2e/*.test.ts` == number of test files |
| `COMPOSE_REQUIRED` has ≤8 entries | Manual review of the manifest |
| `tests/e2e/AUDIT.md` exists and is committed | File present at HEAD |
| No silent test skips | vitest output shows N run / N pass, no skipped |
| API contract honored | `curl /health` returns `{db: "live"}` on dev, `{db: "stub"}` on dev:fast; `curl /api/things` returns 503 on dev:fast, 200+rows on dev |
| Daemon shutdown still clean | `lich up dev:fast && lich nuke --yes` leaves no orphan processes |
| Postgres data is ephemeral per up/down cycle | `compose.yaml` declares `tmpfs: [/var/lib/postgresql/data]`; first query after fresh `lich up dev` sees only the 3 seeded rows (not stale data from a prior run) |

Numeric targets (wall-clock, COMPOSE_REQUIRED size) are stretch goals. If we miss, document why in AUDIT.md but don't block on them.

## Out of scope

- **Phase 3 coverage expansion** (Tasks 6-13 of `2026-05-25-dogfood-stack-redesign-and-expansion.md` — env_files, env_from, env_group, health_probe, after_ready, before_down, dev:lite, show:version). Paused; resumes after this design ships.
- **Lich engine changes.** The compose-override gap surfaced by LEV-463 (image/healthcheck/etc. dropped from generated override) is filed as a separate Linear issue. Not in scope here.
- **Unit tests under `packages/lich/tests/unit/`.** Out of scope; their runtime is already <10s.
- **CI configuration.** This design is about the local `bun run test` invocation. CI may need parallel-pool worker tuning later, separately.

## Coordination notes

- **LEV-463 has landed on master (`9cf131f`).** All plan tasks branch from current master; no conflict with the supabase→postgres swap.
- **LEV-465's afterEach timeouts (20s) are preserved** — they apply to all tests regardless of pool. The `compose` pool's hookTimeout (60s) is an outer ceiling; the per-test `afterEach({...}, 20_000)` is the actual budget.
- **LEV-466's polling loop in `dashboard-parallel-stacks.test.ts`** is preserved verbatim during migration.
- **Compose-override gap** (LEV-463 finding): `services.postgres` already uses `compose_file: compose.yaml` workaround. This design does not relitigate; the workaround stays.

## Notes & gotchas

- **Postgres uses tmpfs** for `/var/lib/postgresql/data` (see Section 8). Data is ephemeral across `lich down → lich up` cycles, so tests can assert exact row counts (`== 3`) rather than `>=`. Within a single up session, data persists normally.
- **`expectDbMode` failure messages** name the likely cause ("did this test forget to pass `dev`?") so future readers diagnose quickly.
- **Parallel pool size (`maxForks: 4`)** is a starting point. If audit reveals a port-allocation race or daemon contention under parallel load, drop to 2 or stay single-fork for affected tests.
- **Audit doc commits incrementally.** Don't wait for a complete audit before migrating — fill in each row as the corresponding test gets migrated/hardened.
