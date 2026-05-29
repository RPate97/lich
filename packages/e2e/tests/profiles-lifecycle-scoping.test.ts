
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail-loud — the binary is OUR code; a broken
// build is a real bug to surface, not something to skip past.
// ---------------------------------------------------------------------------

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
  // dogfood-stack's `dev` profile starts api + web + postgres + tunnel_demo,
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
    "(setup) brings up the dogfood-stack under the `dev` profile",
    async () => {
      fix = makeFixture("profiles-lifecycle-dev");

      // Progress logger — writes to stderr so the user sees what phase
      // we're in rather than staring at silence for minutes (mirrors
      // lifecycle-env-group.test.ts).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up dev (runs after_up: psql migration + seed)");
      // Mark didUp=true BEFORE invoking up — even a partial up (e.g.
      // postgres container started but the after_up hook failed) leaves
      // the container and owned PIDs behind that need `lich nuke` to
      // reclaim. If we waited until exit 0 to set this flag, a hook
      // failure would leak resources because teardown's `if (didUp)` gate
      // would be false. nuke is idempotent against partial state.
      didUp = true;
      // Explicit "dev" profile arg: the e2e suite's default flipped to
      // dev:fast (no postgres). This test exercises postgres + after_up
      // migration/seed and lives in the compose pool — see
      // tests/e2e/_pool-manifest.ts.
      const upResult = runLich(["up", "dev"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        // up against the full dogfood stack: postgres pulls fast (~5MB
        // alpine) plus the migration + seed psql calls. 4 minutes is the
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

      // Probe /health and verify db: "live" — catches accidental profile
      // drift loudly at setup time. If the dispatcher ever lost the "dev"
      // arg above (default flip, env leak), this fails with a clear
      // message instead of silently passing with stub data.
      //
      // `urls --raw` returns the localhost upstream (http://127.0.0.1:<port>)
      // rather than the friendly URL via the daemon proxy. The friendly URL
      // routing can race the proxy's bind / route-table refresh after up;
      // raw probes the api server directly and avoids that race.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
      await expectDbMode(apiUrl!, "live");
    },
    300_000,
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
          // psql against the local postgres is fast (sub-second once up)
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

      // Why we assert count == 3 — the load-bearing detail of this test:
      //
      // Raw postgres (LEV-463 swap; was supabase) has no auto-seed: the
      // bare `postgres:16-alpine` container starts an empty DB. Schema
      // and rows ONLY exist if the profile-scoped after_up hooks ran:
      //   - `psql "$DATABASE_URL" -f db/migrations/01_init.sql` — creates
      //     `public.things`. If it didn't run, `select count(*) from
      //     things` errors with "relation does not exist" (exit non-zero)
      //     and we fail at the previous expect(result.exitCode).toBe(0).
      //   - `psql "$DATABASE_URL" -f db/seed.sql` — inserts 3 rows. If
      //     it didn't run, count is 0 and this assertion fires.
      //
      // The DISCRIMINATOR between "lich after_up ran" and "lich silently
      // dropped the profile-scoped lifecycle" is therefore count == 3:
      //   - If lich's after_up was silently skipped (Plan 3 regression
      //     where `up.ts` drops the profile's lifecycle list, the bug
      //     this test guards against), the migration never ran either —
      //     the previous psql exit-code check already caught it. If only
      //     the seed was skipped (unlikely partial regression), count
      //     would be 0.
      //   - If lich's after_up ran, count is exactly 3.
      //
      // Previously this used `>= 3` to tolerate the default anonymous
      // postgres volume persisting rows across lich down/up cycles. With
      // the compose tmpfs mount (e2e suite solid+fast design Section 8),
      // postgres data is ephemeral per up/down cycle, so we can tighten
      // to `== 3` — exactly the rows the seed planted.
      const count = parseInt(result.stdout.trim(), 10);
      expect(
        count,
        `psql returned "${result.stdout.trim()}" — expected exactly 3 ` +
          `(3 rows from after_up's psql -f db/seed.sql against an ephemeral ` +
          `tmpfs-backed postgres); count of 0 would mean lich silently ` +
          `dropped the profile-scoped after_up seed step.`,
      ).toBe(3);
    },
    60_000,
  );

  it(
    "(teardown) lich nuke + tmpdir cleanup",
    () => {
      if (fix) teardownFixture(fix, didUp);
      fix = null;
      didUp = false;
    },
    180_000,
  );
});
