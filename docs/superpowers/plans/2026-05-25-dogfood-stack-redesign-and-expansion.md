# Dogfood-Stack Redesign + Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Supersedes:** `2026-05-25-dogfood-stack-expansion.md` (now obsolete). The redesign drops supabase from the test stack in favor of raw `postgres:16-alpine` (~3s startup vs supabase's ~35s), reverts the redis + mailhog work (Task 2 of the old plan), and adds three speed/correctness fixes that surfaced during execution.

**Goal:** Speed up the e2e suite by an order of magnitude, fix the failures a full run surfaced, then complete the dogfood-stack feature coverage expansion.

**Architecture:** Three phases — (1) replace supabase with a lighter Postgres-equivalent + fix the test-rot/bug failures so the suite is fast and green; (2) verify the suite is actually clean; (3) add the remaining feature-coverage tasks (env_files, env_from, env_group, ready_when.cmd, after_ready, before_down, dev:lite, show:version).

**Tech Stack:** Bun + TypeScript (lich binary), Vitest (unit + e2e), `postgres:16-alpine` (compose), OrbStack or Docker Desktop, existing `tests/e2e/helpers/*` modules.

**Source:** `docs/superpowers/specs/2026-05-25-dogfood-stack-expansion-design.md` (revised in place to reflect the postgres pivot — see §13 addendum).

---

## Task ordering rationale

```
PHASE 1 — SPEED + FIXES (foundational)
  Task 0:  Revert Task 2 (redis + mailhog)
  Task 1:  Replace supabase with postgres
  Task 2:  Fix parseLichUrls + add regression unit test (Bucket A)
  Task 3:  Tighten test afterEach timeouts + investigate daemon hang (Bucket B)
  Task 4:  Fix dashboard-parallel-stacks race (Bucket C)

PHASE 2 — VERIFY
  Task 5:  Full e2e checkpoint — must be green before Phase 3

PHASE 3 — EXPANSION (modified from old plan)
  Task 6:  env_files (.env)
  Task 7:  env_from + fake-secrets.sh
  Task 8:  from-cmd-secrets env_group
  Task 9:  health_probe service (ready_when.cmd)
  Task 10: api after_ready hook
  Task 11: lifecycle.before_down
  Task 12: dev:lite profile
  Task 13: show:version command
  Task 14: Final verification
```

## Conventions

- Build the binary (`cd packages/lich && bun run build`) before any e2e run.
- `LICH` env var = `/Users/ryan/Desktop/programming/levelzero/packages/lich/dist/lich`.
- TDD where applicable. For pure refactors / reverts, write the test that pins the new behavior first.
- Each task = one commit. Stay-in-worktree pattern (agents commit on their branch, orchestrator cherry-picks).
- After this plan ships, the dogfood-stack is ~5-8s startup (was ~35s with supabase).

---

## PHASE 1 — SPEED + FIXES

### Task 0: Revert Task 2 (redis + mailhog)

The compose-service expansion landed at commit `9910244` but the redesign drops redis + mailhog. Revert so subsequent tasks start from a clean baseline.

**Files affected by revert:**
- `examples/dogfood-stack/lich.yaml` — strip `services:` block (redis + mailhog), strip `REDIS_URL`/`SMTP_URL` env vars, strip `services: [redis, mailhog]` from `dev` profile
- `tests/e2e/dogfood-compose-services.test.ts` — delete entirely
- `tests/e2e/basic-up.test.ts` — undo the service-name array changes
- `tests/e2e/dashboard-stack-list.test.ts` — undo the service-name array changes + `expectedKinds` map
- `tests/e2e/dashboard-stack-detail.test.ts` — undo the service-name array changes + `expectedKinds` map

- [ ] **Step 1: Revert the commit**

Run: `git revert --no-edit 9910244`. If the revert is clean, commit lands automatically with the message `Revert "feat(dogfood): add redis + mailhog compose services with e2e coverage"`. If conflicts arise (they shouldn't — no later commits touch the same files yet), resolve by keeping master's current state minus Task 2's additions.

- [ ] **Step 2: Verify**

Run: `$LICH validate examples/dogfood-stack/lich.yaml` — exit 0. `cd packages/lich && bun run build` — clean.

- [ ] **Step 3: Commit**

If `git revert` already committed, the commit is done. Otherwise:

```bash
git commit -m "Revert \"feat(dogfood): add redis + mailhog compose services with e2e coverage\"

Per the post-execution redesign (docs/superpowers/plans/2026-05-25-dogfood-stack-redesign-and-expansion.md), the test stack drops supabase in favor of raw postgres, and redis + mailhog are no longer needed for feature coverage."
```

---

### Task 1: Replace supabase with postgres

The biggest reshape. Supabase is dropped; raw `postgres:16-alpine` takes its place. Startup goes from ~35s to ~3s.

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (drop `owned.supabase`, add `services.postgres`, rewire `env:`, update `dev` + `dev:env-override` profiles' lifecycle hooks)
- Delete: `examples/dogfood-stack/supabase/` (entire directory — config.toml, edge-functions/, migrations/, seed.sql get moved or dropped)
- Create: `examples/dogfood-stack/db/migrations/01_init.sql` (ported from `supabase/migrations/*.sql`)
- Create: `examples/dogfood-stack/db/seed.sql` (ported from `supabase/seed.sql`)
- Update: every existing e2e test that references supabase or its specific env vars (`SUPABASE_API_PORT`, `SUPABASE_DB_PORT`, etc.)

- [ ] **Step 1: Inspect what's there**

Run: `ls examples/dogfood-stack/supabase/` and `cat examples/dogfood-stack/supabase/migrations/*.sql examples/dogfood-stack/supabase/seed.sql`. Catalog the SQL content so you can port it to `db/`.

- [ ] **Step 2: Create the new `db/` directory + ported SQL files**

```bash
mkdir -p examples/dogfood-stack/db/migrations
```

Create `examples/dogfood-stack/db/migrations/01_init.sql` — copy the `CREATE TABLE` statements from the supabase migrations. Drop any supabase-specific extensions or auth schema setup (raw postgres doesn't have them).

Create `examples/dogfood-stack/db/seed.sql` — port the seed data from `supabase/seed.sql`, dropping any auth-related rows. Keep the `things` table population (which the existing `profiles-lifecycle-scoping.test.ts` asserts on with `select count(*) from things`).

- [ ] **Step 3: Rewrite `examples/dogfood-stack/lich.yaml`**

Replace the existing `owned.supabase` block with a new `services.postgres` block. The full diff to the yaml:

**Drop the `owned.supabase` block entirely** (currently lines ~9-35 of lich.yaml).

**Add `services.postgres`** to the `services:` block (or create the block if Task 0's revert left no `services:`):

```yaml
services:
  # Plan 1 compose service. Replaces supabase (~3s startup vs ~35s).
  # Single port → POSTGRES_HOST_PORT. Healthcheck via pg_isready.
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_HOST_PORT }
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

**Update the `env:` block** — DATABASE_URL now points at postgres (drop all `${owned.supabase.ports.*}` refs; replace with `${services.postgres.host_port}`):

```yaml
env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/dogfood"
  API_URL: "http://localhost:${owned.api.port}"
  # Drop SUPABASE_* env vars + the SUPABASE_PROJECT_ID interpolation entirely.
  # The `dev:env-override` profile still demonstrates env override (DATABASE_URL
  # is now the override target).
```

**Update `owned.api.depends_on`** from `[supabase]` to `[postgres]`:

```yaml
owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    depends_on: [postgres]
    # ... rest unchanged
```

**Update `dev` profile's `lifecycle.after_up`** — replace supabase CLI calls with plain psql:

```yaml
profiles:
  dev:
    default: true
    services: [postgres]
    owned: [api, web, tunnel_demo]   # health_probe will be added in Task 9
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed.sql
```

**Update `dev:env-override` profile** — the override URL was supabase-specific; keep the "intentionally non-resolving" semantics:

```yaml
  dev:env-override:
    extends: dev
    env:
      DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/dogfood"
```

- [ ] **Step 4: Delete the supabase directory**

```bash
rm -rf examples/dogfood-stack/supabase
```

- [ ] **Step 5: Validate**

Run: `$LICH validate examples/dogfood-stack/lich.yaml` — exit 0.

- [ ] **Step 6: Update tests that reference supabase**

Grep for any remaining references:

```bash
grep -rn "supabase\|SUPABASE" tests/e2e/ packages/lich/tests/
```

Common updates:
- `tests/e2e/basic-up.test.ts` — service-name array changes from `["api", "supabase", "tunnel_demo", "web"]` to `["api", "postgres", "tunnel_demo", "web"]` (and `postgres` is `kind: "compose"`, not `"owned"`)
- `tests/e2e/dashboard-stack-list.test.ts` — same shape change
- `tests/e2e/dashboard-stack-detail.test.ts` — same
- `tests/e2e/profiles-default.test.ts` / `profiles-named.test.ts` / `profiles-env-override.test.ts` — verify DATABASE_URL assertions still match (postgres instead of supabase's pg, same host/port pattern)
- `tests/e2e/profiles-lifecycle-scoping.test.ts` — the `select count(*) from things` assertion should still work against the new migrations
- `tests/e2e/parallel-stacks.test.ts` — service-name + count expectations

For each file, run it and let the failure tell you exactly what to update.

- [ ] **Step 7: Rebuild + smoke check**

```bash
cd packages/lich && bun run build
cd examples/dogfood-stack && $LICH up dev --no-browser
# Expected: stack reaches up in <10s. api/health responds. psql migrations + seed ran.
$LICH exec -- sh -c "psql \"\$DATABASE_URL\" -tAc 'select count(*) from things'"
# Expected: positive integer (seed rows)
$LICH down --yes
```

- [ ] **Step 8: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        examples/dogfood-stack/db/ \
        tests/e2e/*.ts
git rm -r examples/dogfood-stack/supabase/
git commit -m "feat(dogfood): replace supabase with postgres for ~10x faster test startup"
```

---

### Task 2: Fix `parseLichUrls` + regression unit test (Bucket A)

The helper at `tests/e2e/helpers/urls.ts` doesn't handle post-LEV-419 friendly-URL output. Real test rot — 4 tests broken because of it.

**Files:**
- Modify: `tests/e2e/helpers/urls.ts`
- Create: `tests/e2e/helpers/urls.test.ts`

- [ ] **Step 1: Inspect the current helper**

Read `tests/e2e/helpers/urls.ts`. The `parseLichUrls` function probably splits on `: ` and treats the LHS as the key. With the new output, lines like `supabase (api): http://...` get parsed with key `"supabase (api)"` instead of being skipped or recognized.

- [ ] **Step 2: Write the failing unit test first (TDD)**

Create `tests/e2e/helpers/urls.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseLichUrls, portFromUrl } from "./urls.js";

describe("parseLichUrls", () => {
  it("parses simple single-service output (post-LEV-419 default friendly URLs)", () => {
    // After LEV-419 (friendly URLs by default), lich urls emits friendly
    // hostnames keyed by service name. Multi-port owned services emit
    // multiple lines like "supabase (api): http://supabase-api.<wt>...".
    const output = `\
api: http://api.lich-e2e-foo.lich.localhost:3300/
web: http://web.lich-e2e-foo.lich.localhost:3300/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.lich-e2e-foo.lich.localhost:3300/");
    expect(urls.web).toBe("http://web.lich-e2e-foo.lich.localhost:3300/");
  });

  it("parses multi-port friendly URL output (parenthesized port key)", () => {
    // Multi-port owned service emits one line per port. The simple service
    // name appears alongside the parenthesized variants.
    const output = `\
supabase (api): http://supabase-api.lich-e2e-foo.lich.localhost:3300/
supabase (db): http://supabase-db.lich-e2e-foo.lich.localhost:3300/
api: http://api.lich-e2e-foo.lich.localhost:3300/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.lich-e2e-foo.lich.localhost:3300/");
    // Multi-port entries use a "service.portkey" key shape so callers can
    // address individual ports.
    expect(urls["supabase.api"]).toBe(
      "http://supabase-api.lich-e2e-foo.lich.localhost:3300/",
    );
    expect(urls["supabase.db"]).toBe(
      "http://supabase-db.lich-e2e-foo.lich.localhost:3300/",
    );
  });

  it("parses raw URL output (--raw flag)", () => {
    // `lich urls --raw` emits localhost URLs with raw ports.
    const output = `\
api: http://127.0.0.1:9014/
web: http://127.0.0.1:9015/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://127.0.0.1:9014/");
  });

  it("ignores blank lines and unknown prefixes", () => {
    const output = `\n\nnot a urls line\napi: http://api.foo.lich.localhost:3300/\n\n`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.foo.lich.localhost:3300/");
    expect(Object.keys(urls)).toEqual(["api"]);
  });
});

describe("portFromUrl", () => {
  it("extracts the port from a URL", () => {
    expect(portFromUrl("http://127.0.0.1:9014/")).toBe(9014);
    expect(portFromUrl("http://api.foo.lich.localhost:3300/")).toBe(3300);
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL**

Run: `cd tests/e2e && bun run test helpers/urls.test.ts`. Expected: the multi-port friendly URL test fails (and possibly others, depending on the current helper's exact bugs).

- [ ] **Step 4: Rewrite `parseLichUrls`**

Update `tests/e2e/helpers/urls.ts` to handle the post-LEV-419 output:

```ts
export interface UrlMap {
  [key: string]: string;
}

/**
 * Parse `lich urls` output into a key → URL map.
 *
 * Handles both the default friendly-URL output (post-LEV-419, e.g.
 * `api: http://api.<wt>.lich.localhost:3300/`) and the `--raw` flag output
 * (e.g. `api: http://127.0.0.1:9014/`).
 *
 * Multi-port owned services emit one line per port with a parenthesized
 * port key: `supabase (api): http://supabase-api.<wt>.lich.localhost:3300/`.
 * These are surfaced under the key `<service>.<portkey>` so callers can
 * address individual ports without parsing the parenthesized form
 * themselves.
 */
export function parseLichUrls(stdout: string): UrlMap {
  const result: UrlMap = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match "key: url" where key may be "service" or "service (portkey)".
    const m = trimmed.match(/^([a-z0-9_-]+)(?:\s+\(([a-z0-9_-]+)\))?\s*:\s*(https?:\/\/\S+)$/);
    if (!m) continue;

    const [, service, portKey, url] = m;
    const key = portKey ? `${service}.${portKey}` : service;
    result[key] = url;
  }
  return result;
}

export function portFromUrl(url: string): number {
  const m = url.match(/:(\d+)/);
  if (!m) throw new Error(`no port in URL: ${url}`);
  return parseInt(m[1], 10);
}
```

- [ ] **Step 5: Run the unit test — expect PASS**

Run: `cd tests/e2e && bun run test helpers/urls.test.ts`. Expected: all pass.

- [ ] **Step 6: Verify affected e2e tests now parse correctly**

For `basic-up.test.ts`, `restart-basic.test.ts`, `logs.test.ts`, `parallel-stacks.test.ts`: each uses `parseLichUrls`. The assertions previously looked for keys like `"api"` and `"web"` and got confused by `"supabase (api)"`. Now they get clean `"api"` and `"web"` keys (and the supabase entries land under `supabase.api`, etc., which the assertions can ignore).

For each test, verify the assertion shape is still correct. Note: Task 1 already replaced supabase with postgres (single-port), so the multi-port output may not even appear in dogfood-stack tests anymore — the parseLichUrls fix is still important for any future multi-port owned services.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/helpers/urls.ts tests/e2e/helpers/urls.test.ts
git commit -m "fix(tests): parseLichUrls handles post-LEV-419 friendly-URL output + regression test"
```

---

### Task 3: Tighten afterEach timeouts + investigate daemon hang (Bucket B)

**Symptom:** 6 tests pass their bodies but afterEach hooks time out trying to nuke. "killed 1 dangling process" suggests the daemon hangs on shutdown.

**Investigation goals:**
1. Does `lich nuke --yes` actually kill the daemon? (LEV-420 added this; verify it works.)
2. If yes, why does afterEach time out? Maybe the test's afterEach uses `lich down` (not nuke), and the daemon's auto-shutdown grace (~30s) holds the test slot.
3. Should test afterEach timeouts be shorter (10s) to fail loudly rather than mask?

**Files:**
- Modify: every e2e test with a multi-minute afterEach timeout (`120_000`+ ms) — drop to `20_000` ms
- Possibly: `packages/lich/src/daemon/daemon.ts` if there's a real shutdown bug
- Possibly: file a Linear issue if the daemon truly hangs

- [ ] **Step 1: Diagnose**

Run this loop locally:

```bash
cd /tmp && mkdir -p lich-diag && cd lich-diag
mkdir LICH_HOME
LICH_HOME=$PWD/LICH_HOME $LICH up dev --no-browser   # in dogfood tmpdir or copy
# In another terminal:
LICH_HOME=$PWD/LICH_HOME $LICH nuke --yes
ps aux | grep lich-daemon
```

If `lich-daemon` is still alive 5s after nuke → real bug. Capture details and file a Linear issue (call it LEV-462). If it's gone → the test timeout config is the issue.

- [ ] **Step 2: Tighten afterEach timeouts**

For each test with `timeout: 60_000` or `120_000` in `afterEach` blocks, drop to `20_000`. Sample sed (verify per file):

```bash
grep -lE 'afterEach.*60_000|afterEach.*120_000' tests/e2e/*.ts
```

Manually update each — afterEach should be a fast cleanup, not a long-running operation. If the cleanup genuinely needs >20s, that's a bug to investigate, not a timeout to increase.

- [ ] **Step 3: If Step 1 surfaced a real daemon bug**

Apply the fix (likely in `packages/lich/src/daemon/daemon.ts` shutdown path). Add a unit test in `packages/lich/tests/unit/daemon/daemon.test.ts` that asserts shutdown completes within 5s on SIGTERM.

If the fix is non-trivial, file a Linear issue (LEV-462) and proceed with the timeout-tightening alone — the tighter timeouts will surface the bug loudly even before it's fixed.

- [ ] **Step 4: Verify**

Run one of the previously-flaky tests:

```bash
cd tests/e2e && bun run test dashboard-stack-detail.test.ts
```

Expected: passes (or fails fast on the real bug — not hangs for 60s).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/*.ts packages/lich/src/daemon/ packages/lich/tests/unit/daemon/
git commit -m "fix(tests): tighten afterEach timeouts; daemon shutdown investigation"
```

(Commit message body should note whether a real bug was found and link to LEV-462 if applicable.)

---

### Task 4: Fix dashboard-parallel-stacks race (Bucket C)

**Symptom:** test fetches `/api/stacks` and expects stackB `status: "up"`, gets `status: "starting"`. The dashboard's view of stackB is stale because `lich up` returns before the dashboard's cache catches up.

**Files:**
- Modify: `tests/e2e/dashboard-parallel-stacks.test.ts`

- [ ] **Step 1: Add `waitForStackStatus` before the assertion**

In the test, before the `/api/stacks` fetch:

```ts
// Wait for the dashboard's view of stackB to catch up to status:up before
// asserting. lich up returns once state.json is written; the dashboard's
// cache refresh runs on the watcher's debounce (~100ms) so there's a
// small window where the API still shows "starting".
await waitForStackStatus(lichHome, stateB!.stack_id, "up", { timeoutMs: 10_000 });
```

(Adapt to the existing helper signature in `tests/e2e/helpers/state.ts`.)

- [ ] **Step 2: Run the test**

Run: `cd tests/e2e && bun run test dashboard-parallel-stacks.test.ts`. Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/dashboard-parallel-stacks.test.ts
git commit -m "fix(tests): wait for stackB status:up before dashboard assertion (LEV-430 race)"
```

---

## PHASE 2 — VERIFY

### Task 5: Full e2e checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Clean docker state**

```bash
# Kill any lingering test stacks (the cleanup script from earlier):
docker ps -aq --filter "label=com.docker.compose.project" | xargs -r docker rm -f 2>/dev/null
docker volume prune -f 2>/dev/null
```

- [ ] **Step 2: Build the binary**

```bash
cd packages/lich && bun run build
```

- [ ] **Step 3: Full unit suite**

```bash
cd packages/lich && bun run test
```

Expected: 0 fail. (The new `parseLichUrls` unit test should appear here too.)

- [ ] **Step 4: Full e2e suite**

```bash
cd tests/e2e && bun test
```

Expected: 0 fail. Total runtime should be ~5-8 min (down from 28 min) because each test's startup dropped from ~35s to ~5s with postgres replacing supabase.

If any test still fails: triage. If it's a real bug, file a Linear issue and fix in a sub-task. If it's environmental (docker contention), retry. If it's a real regression from this plan's earlier tasks, that's the priority fix.

- [ ] **Step 5: Commit (only if changes were needed during triage)**

```bash
git add -A
git commit -m "fix(tests): post-redesign e2e cleanup (specifics in commit body)"
```

---

## PHASE 3 — EXPANSION

The remaining tasks are the original expansion work, adapted for the new postgres-based stack. Each task is the same shape as the old plan: yaml + fixture(s) + new e2e test + commit.

The full bodies of these tasks are unchanged from the old plan (`docs/superpowers/plans/2026-05-25-dogfood-stack-expansion.md`) EXCEPT for the substitutions noted below. Re-read the old plan's Task 3-12 for the detailed code; this section only highlights the deltas.

### Task 6: env_files (.env)

Identical to old plan's Task 3. No supabase-related changes needed.

### Task 7: env_from + fake-secrets.sh

Identical to old plan's Task 4.

### Task 8: from-cmd-secrets env_group

Identical to old plan's Task 5.

### Task 9: health_probe service (ready_when.cmd)

Identical to old plan's Task 6, EXCEPT:
- The expected service-name array updates are simpler now — add `"health_probe"` to whatever the post-Task-1 (postgres swap) list looks like
- `dev` profile's owned list goes from `[api, web, tunnel_demo]` to `[api, web, tunnel_demo, health_probe]`

### Task 10: api after_ready hook

Identical to old plan's Task 7.

### Task 11: lifecycle.before_down

Identical to old plan's Task 8.

### Task 12: dev:lite profile

SIMPLIFIED from old plan's Task 9. With only one compose service (postgres) and no optional compose services to exclude, `dev:lite` is just an owned-trimmed variant. No api code change for opt-in REDIS_URL (redis is gone).

```yaml
profiles:
  dev:lite:
    # Minimal fast-iteration profile: keeps postgres + api + web, drops
    # the optional owned services (tunnel_demo, health_probe). Demonstrates
    # the exclude-services pattern (explicit owned list REPLACES the
    # implicit "all declared" set, doesn't subtract).
    services: [postgres]
    owned: [api, web]
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed.sql
```

E2e test asserts the dev:lite stack lists only `[api, postgres, web]`, NOT `[tunnel_demo, health_probe]`.

### Task 13: show:version command

Identical to old plan's Task 10.

### `cache:flush` command — DELETED (was redis-specific; no replacement)

### Task 14: Final verification

Identical to old plan's Task 12, with the dogfood-stack now postgres-based. Add a manual step:

- [ ] **Step: Verify suite runtime is under 10 min**

If the full e2e suite takes >10 min on a clean docker daemon, the redesign didn't achieve its speed goal — investigate.

- [ ] **Step: Mark this plan + the spec as Implemented**

In `docs/superpowers/specs/2026-05-25-dogfood-stack-expansion-design.md`, update the status:

```markdown
> **Status:** Implemented (with redesign). See
> `docs/superpowers/plans/2026-05-25-dogfood-stack-redesign-and-expansion.md`
> for the as-built plan.
```

In the OLD plan file's header, add:

```markdown
> **Superseded by:** `2026-05-25-dogfood-stack-redesign-and-expansion.md`.
> The supabase-based approach was replaced with raw postgres for speed.
```

---

## Self-review summary

**Phase 1 task coverage:**
- Bucket A (parseLichUrls) → Task 2 ✓
- Bucket B (afterEach timeouts) → Task 3 ✓
- Bucket C (parallel-stacks race) → Task 4 ✓
- supabase → postgres pivot → Task 1 ✓
- Task 2 revert → Task 0 ✓

**Phase 3 task coverage (vs old plan):**
- env_files → Task 6 ✓
- env_from → Task 7 ✓
- env_group → Task 8 ✓
- ready_when.cmd → Task 9 ✓
- after_ready → Task 10 ✓
- before_down → Task 11 ✓
- dev:lite → Task 12 ✓ (simplified)
- show:version → Task 13 ✓
- cache:flush → DELETED (intentional)
- final verification → Task 14 ✓

**Placeholder scan:** none of the disallowed patterns appear.

**Cross-task identifier consistency:** verified — `postgres` (compose service name), `DATABASE_URL`, `db/migrations/01_init.sql`, `db/seed.sql`, `dev:lite`, `health_probe`, `from-cmd-secrets`, `show:version`, `parseLichUrls` are referenced consistently across the tasks that use them.
