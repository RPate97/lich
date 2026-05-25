/**
 * Plan 3 Task 23 (LEV-397) — profile-scoped `lifecycle.after_up`
 * actually runs migrations + seed under the `dev` profile.
 *
 * Coverage target:
 *
 *   `after_up under dev profile runs migrations + seed`
 *      The dogfood-stack's `dev` profile carries:
 *          lifecycle.after_up:
 *            - supabase migration up
 *            - psql "$DATABASE_URL" -f supabase/seed.sql
 *      `lich up` (default = dev) must execute both hooks. We assert this by
 *      counting rows in `public.things` via psql against the resolved
 *      DATABASE_URL — the migration creates the table, the seed plants 3
 *      rows. If either hook is dropped, the assertion fires:
 *        - migration skipped → table doesn't exist → psql errors
 *        - seed skipped → table empty → count is 0, not 3
 *      This is THE load-bearing proof that profile-scoped lifecycle wires
 *      through `commands/up.ts` (Plan 3 Task 15 / LEV-389). Before Plan 3,
 *      Plan 1's `up.ts` only executed top-level `config.lifecycle.*` and
 *      ignored `profiles.dev.lifecycle.*` entirely — so the rows were never
 *      there to count.
 *
 * Why no `dev:env-override` companion test:
 *   The plan's Task 23 description proposes a second test asserting the
 *   same count under `dev:env-override` (which `extends: dev`, so the
 *   lifecycle composes to the same after_up entries). In practice that
 *   test cannot pass:
 *     - `dev:env-override` overrides `DATABASE_URL` to a non-resolving
 *       hostname (db.test.example.com) per the dogfood yaml.
 *     - The inherited `after_up` resolves the seed's `$DATABASE_URL`
 *       against the active profile's env at execution time — which IS
 *       the overridden hostname.
 *     - `psql "$DATABASE_URL" -f seed.sql` therefore fails to connect,
 *       the after_up phase aborts, and `lich up` exits non-zero.
 *   The seed cannot reach a real Postgres unless the active profile's
 *   resolved DATABASE_URL points at one. Demonstrating "the extends
 *   chain composes lifecycle correctly" without that connectivity
 *   requires either:
 *     (a) a marker-script hook (like lifecycle-env-group.test.ts does
 *         with write-marker.sh) that doesn't need network reachability;
 *     (b) reshaping the dogfood-stack so `dev:env-override` keeps a
 *         working DATABASE_URL.
 *   Both are out of scope for Task 23. The lifecycle-composition
 *   semantic is already exercised by the unit tests for
 *   `profiles/resolve.ts` (`composes lifecycle.after_up: parent entries
 *   first, then child entries`) and by `commands/up.test.ts`. The
 *   "after_up does NOT run for a profile that excludes supabase"
 *   scenario the plan flagged as optional is similarly deferred — the
 *   dogfood-stack has no such profile today.
 *
 * Why we observe via psql (not via api endpoints):
 *   The api ships no /things endpoint, and adding one would couple this
 *   test to api shape changes. psql is the most direct observation: the
 *   migration creates a table, the seed inserts rows, `select count(*)`
 *   reads them back. The `lich exec` proxy routes through the same env
 *   pipeline as the after_up hook, so the test exercises the SAME
 *   DATABASE_URL the hook resolved (worktree-scoped Supabase port).
 *
 * Why we use `lich exec` to invoke psql (not psql directly from the test):
 *   `lich exec` resolves the stack env_group, which picks up the active
 *   profile's resolved env (Plan 3 Task 6 / LEV-380). Running psql via the
 *   shell directly would require the test to know the worktree's allocated
 *   Supabase port — which is exactly what the exec path computes for us.
 *   It also catches a class of bug where `after_up` ran against a DIFFERENT
 *   resolved DATABASE_URL than what subsequent stack consumers see.
 *
 * Prerequisites: docker + supabase CLI v2+ on PATH (the supabase CLI ships
 * psql under its bundled tools, but most dev machines also have a system
 * psql via libpq / homebrew). Without them `lich up` errors loudly; see
 * tests/e2e/README.md and Plan 0's prerequisites.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME under a per-test tmpdir so the user's real ~/.lich is
 *     untouched and concurrent runs don't collide on stack ids.
 *   - lich binary built once up front in `beforeAll`.
 *
 * Resource cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in the final (teardown) it() so docker
 *     resources and owned PIDs from the dogfood stack don't leak even if
 *     the body throws.
 *
 * Hook timing (matches profiles-named.test.ts):
 *   Setup/teardown live in `it()` blocks (not beforeAll/afterAll) so each
 *   step gets a generous per-it timeout. Bun ignores the per-hook timeout
 *   that vitest accepts; `it()` timeouts are honored.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail-loud — the binary is OUR code; a broken
// build is a real bug to surface, not something to skip past.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  if (existsSync(LICH_BINARY)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(LICH_BINARY)) {
    throw new Error(
      `lich build reported success but ${LICH_BINARY} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-test fixture state. One fixture for the single dev-profile test.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

/** Helper: build a fresh fixture with a per-test LICH_HOME and dogfood copy. */
function makeFixture(prefix: string): Fixture {
  // install: true — apps/web's `next dev` and apps/api's `bun run dev` need
  // node_modules in the copy (same pattern as basic-up.test.ts). The
  // dogfood-stack's `dev` profile starts api + web + supabase + tunnel_demo,
  // so the install is required for `lich up` to succeed at all.
  const stack = copyExampleToTmpdir("dogfood-stack", {
    prefix: `lich-e2e-${prefix}-`,
    install: true,
  });
  const home = mkdtempSync(join(tmpdir(), `lich-e2e-${prefix}-home-`));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Best-effort teardown — swallow errors so a cleanup failure doesn't mask
 * the real assertion failure. We use `lich nuke --yes` (not `lich down`)
 * because nuke is idempotent against partially-up stacks and reclaims
 * docker + owned PIDs even when the snapshot is in an unexpected state.
 */
function teardownFixture(fix: Fixture, didUp: boolean): void {
  if (didUp) {
    try {
      // Best-effort nuke; ignore exit code. We're tearing down only the
      // resources THIS test created by scoping LICH_HOME — never another
      // stack the user is running by hand.
      //
      // LEV-465: timeout tightened from 120s → 20s. afterEach is a fast
      // cleanup path; vitest's hookTimeout caps at 60s anyway, and
      // `lich nuke --yes` completes sub-200ms even when killing a
      // live daemon (SIGTERM → 5s grace → SIGKILL).
      spawnSync(LICH_BINARY, ["nuke", "--yes"], {
        cwd: fix.stackPath,
        env: { ...process.env, LICH_HOME: fix.lichHome },
        timeout: 20_000,
        encoding: "utf8",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`teardown lich nuke failed for ${fix.stackPath}:`, err);
    }
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profile-scoped lifecycle: after_up runs under dev (Plan 3 Task 23)", () => {
  let fix: Fixture | null = null;
  let didUp = false;

  it(
    "(setup) brings up the dogfood-stack under the default `dev` profile",
    () => {
      fix = makeFixture("profiles-lifecycle-dev");

      // Progress logger — writes to stderr so the user sees what phase
      // we're in rather than staring at silence for minutes (mirrors
      // lifecycle-env-group.test.ts).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up (runs after_up: supabase migration up + seed)");
      // Mark didUp=true BEFORE invoking up — even a partial up (e.g.
      // supabase containers started but the after_up hook failed) leaves
      // docker containers and owned PIDs behind that need `lich nuke` to
      // reclaim. If we waited until exit 0 to set this flag, a hook
      // failure would leak resources because teardown's `if (didUp)` gate
      // would be false. nuke is idempotent against partial state.
      didUp = true;
      const upResult = runLich(["up"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        // up against the full dogfood stack is heavy: supabase first-pull
        // alone can be 60-90s, plus migrations + seed. 4 minutes is the
        // conservative ceiling. Matches profiles-named.test.ts.
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up exited ${upResult.exitCode}; cannot proceed with psql count assertion`,
        );
      }
      step("lich up exit 0 — after_up hooks completed");
    },
    /* timeout */ 300_000,
  );

  it(
    "reports `things` rows populated by the after_up hook",
    () => {
      // The shell `-c` form is required so the shell expands `$DATABASE_URL`.
      // A bare `psql "$DATABASE_URL" -tAc ...` argv would NOT expand the var
      // because `lich exec` spawns the command directly (no shell in between).
      //
      // The `--` separator before `sh` is load-bearing: mri parses the
      // binary's top-level argv and would otherwise eat the `-c` flag as its
      // own option (string value "select count(*) ..."), leaving the exec
      // command with only `["sh"]` in `_` and producing no output. `--` is
      // the standard CLI convention (`docker exec --`, `kubectl exec --`,
      // `git checkout --`) for "stop parsing my flags, treat the rest as
      // opaque positionals" — see tests/e2e/exec.test.ts for the same
      // pattern under Plan 2 Task 19.
      //
      // `-tAc` flags on psql:
      //   -t   tuples-only (no column header / footer row counts)
      //   -A   unaligned (no padding, raw value on one line)
      //   -c   run the following SQL string and exit
      // Together these produce a single line containing just the count
      // value, so we can parse it as an integer.
      const result = runLich(
        [
          "exec",
          "--",
          "sh",
          "-c",
          "psql \"$DATABASE_URL\" -tAc 'select count(*) from things'",
        ],
        {
          cwd: fix!.stackPath,
          env: { LICH_HOME: fix!.lichHome },
          // psql against the local supabase is fast (sub-second once up)
          // but a generous 30s ceiling covers cold-cache cases.
          timeout: 30_000,
        },
      );
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich exec psql stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich exec psql stderr:", result.stderr);
      }
      // Exit 0 proves the table exists (migration ran) AND psql connected
      // to the resolved DATABASE_URL.
      expect(result.exitCode).toBe(0);

      // Why we assert count >= 6 (not == 3) — the load-bearing detail of
      // this test:
      //
      // `supabase/config.toml` has `[db.seed] enabled = true` with
      // `sql_paths = ['./seed.sql']`. `supabase start` (the supabase owned
      // service's `cmd`) does a fresh `db reset` on first launch, which
      // applies migrations AND runs the seed exactly once → 3 rows inserted
      // by Supabase's own startup path.
      //
      // The profile-scoped `after_up` hooks then run AFTER the supabase
      // service is ready:
      //   - `supabase migration up` — idempotent; no new migrations to
      //     apply on a fresh start → 0 new rows.
      //   - `psql "$DATABASE_URL" -f supabase/seed.sql` — re-runs the
      //     seed against the live DB. The seed inserts 3 more rows
      //     (the `on conflict do nothing` clause only protects against
      //     PRIMARY KEY conflicts on `id`, but the inserts don't pin id
      //     so new rows get fresh auto-incremented ids and ALL three
      //     succeed) → 3 more rows = 6 total.
      //
      // The DISCRIMINATOR between "lich after_up ran" and "only supabase
      // auto-seed ran" is therefore count >= 6:
      //   - If lich's after_up was silently skipped (Plan 3 regression
      //     where `up.ts` drops the profile's lifecycle list, the bug
      //     this test guards against), count would be exactly 3 — only
      //     supabase's own start-time seed ran.
      //   - If lich's after_up ran, count is 6 (or higher if `lich up`
      //     was re-run on a persistent volume, which we don't hit here
      //     because each tmpdir gets a fresh project_id).
      //
      // We use `>=` rather than `===` to be robust against future supabase
      // CLI behavior tweaks that might re-seed on subsequent reset/restart
      // (e.g. if `supabase start` ever does a no-op reset that re-seeds).
      // Anything below 6 is a real bug worth surfacing.
      const count = parseInt(result.stdout.trim(), 10);
      expect(
        count,
        `psql returned "${result.stdout.trim()}" — expected an integer ≥ 6 ` +
          `(3 from supabase-start auto-seed + 3 from after_up's psql -f seed.sql); ` +
          `count of exactly 3 would mean lich silently dropped the profile-scoped after_up.`,
      ).toBeGreaterThanOrEqual(6);
    },
    /* timeout */ 60_000,
  );

  it(
    "(teardown) lich nuke + tmpdir cleanup",
    () => {
      if (fix) teardownFixture(fix, didUp);
      fix = null;
      didUp = false;
    },
    /* timeout */ 180_000,
  );
});
