
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
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
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-test fixture state.
//
// Each of the two "happy path" tests gets its own fresh fixture (and its own
// `lich up` invocation) because they activate DIFFERENT profiles. Sharing a
// single up between them is impossible: re-running `lich up <other>` while a
// stack is already up under a different profile is REFUSED by design
// (Plan 3 Task 13 / LEV-387, exercised by tests/e2e/profiles-switch-refused).
//
// The "unknown profile" test owns its own minimal fixture (just the dogfood
// yaml; no install, no docker — the unknown-profile error bails before any
// of that).
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

/** Helper: build a fresh fixture with a per-test LICH_HOME and dogfood copy. */
function makeFixture(prefix: string, install: boolean): Fixture {
  // install: true (only when we'll actually `lich up`) — apps/web runs
  // `next dev` which needs `next` in node_modules/.bin. Without it the web
  // owned service exits 127 immediately. See LEV-313.
  const stack = copyExampleToTmpdir("dogfood-stack", {
    prefix: `lich-e2e-${prefix}-`,
    install,
  });
  const home = mkdtempSync(join(tmpdir(), `lich-e2e-${prefix}-home-`));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/** Best-effort teardown — swallow errors so a cleanup failure doesn't mask
 *  the real assertion failure (it would also leak resources, hence the
 *  console.warn so CI surfaces the leak). */
function teardownFixture(fix: Fixture, didUp: boolean): void {
  if (didUp) {
    try {
      // LEV-465: timeout tightened from 120s → 20s. afterEach is a fast
      // cleanup path; vitest's hookTimeout caps at 60s anyway, so the
      // old value could never actually fire — it just masked teardown
      // hangs as the wrong error.
      runLich(["down"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        timeout: 20_000,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`teardown lich down failed for ${fix.stackPath}:`, err);
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
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The shape `lich stacks --json` emits. Mirrors the inline `JsonRow` in
 * `packages/lich/src/commands/stacks.ts`. We type the field as optional
 * because pre-Plan-3 stack records (and stacks brought up with no profile
 * active) don't carry it.
 */
interface StacksJsonRow {
  stack_id: string;
  worktree_name: string;
  status: string;
  started_at: string;
  uptime_seconds: number;
  services: Array<{ name: string; kind: string; state: string }>;
  primary_url?: string;
  active_profile?: string;
}

/**
 * Run `lich stacks --json` against the per-test LICH_HOME and parse the
 * single matching row for this fixture's worktree. Throws if the output
 * isn't valid JSON or no row matches — both are real bugs to surface.
 */
function readActiveProfileViaStacks(fix: Fixture): string | undefined {
  const result = runLich(["stacks", "--json"], {
    cwd: fix.stackPath,
    env: { LICH_HOME: fix.lichHome },
  });
  if (result.exitCode !== 0) {
    // eslint-disable-next-line no-console
    console.error("lich stacks --json stdout:", result.stdout);
    // eslint-disable-next-line no-console
    console.error("lich stacks --json stderr:", result.stderr);
    throw new Error(`lich stacks --json exited ${result.exitCode}`);
  }
  const rows = JSON.parse(result.stdout) as StacksJsonRow[];
  // Filter to rows whose worktree_name matches this fixture's tmpdir
  // basename. The LICH_HOME is per-test so there's typically only one row,
  // but this filter makes the test robust to any orphan entries a previous
  // run might have left behind.
  //
  // Match case-insensitively: `sanitizeName` in worktree/detect.ts lower-
  // cases the basename (so `mkdtemp` suffixes like `c1OAdB` become
  // `c1oadb`). Substring-either-direction lets the suffix mismatch (the
  // sanitized form replaces non-`[a-z0-9-]` chars with `-`) still resolve
  // — both worktree_name and basename refer to the same path.
  const expectedBasename = (fix.stackPath.split("/").pop() ?? "").toLowerCase();
  const matches = rows.filter((r) => {
    const wt = r.worktree_name.toLowerCase();
    return (
      wt === expectedBasename ||
      expectedBasename.endsWith(wt) ||
      wt.endsWith(expectedBasename)
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one stacks --json row for ${fix.stackPath}, found ${matches.length}: ${JSON.stringify(rows)}`,
    );
  }
  return matches[0].active_profile;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up <profile> activates the named profile (Plan 3 Task 20)", () => {
  // -----------------------------------------------------------------------
  // Test 1: `lich up dev` — explicit profile argument matches the default.
  // -----------------------------------------------------------------------
  describe("lich up dev (explicit default-named profile)", () => {
    let fix: Fixture | null = null;
    let didUp = false;

    it(
      "(setup) brings up the dogfood-stack under the explicit `dev` profile",
      () => {
        fix = makeFixture("profiles-named-dev", true);
        const upResult = runLich(["up", "dev"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          // up against the full dogfood stack: postgres pulls fast (~5MB
          // alpine, LEV-463 swap) but headroom kept for slow CI boxes.
          timeout: 240_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up dev stdout:", upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up dev stderr:", upResult.stderr);
          throw new Error(
            `lich up dev exited ${upResult.exitCode}; cannot proceed with active_profile assertion`,
          );
        }
        didUp = true;
      },
      300_000,
    );

    it("reports active_profile === 'dev' via lich stacks --json", () => {
      const active = readActiveProfileViaStacks(fix!);
      // The load-bearing assertion: the active profile recorded by `up`
      // and surfaced by `stacks` matches the one explicitly requested on
      // the CLI. If this fails, the up → snapshot → stacks chain has
      // dropped the field somewhere — debug there, not in this test.
      expect(active).toBe("dev");
    });

    it(
      "(teardown) lich down + tmpdir cleanup",
      () => {
        if (fix) teardownFixture(fix, didUp);
        fix = null;
        didUp = false;
      },
      180_000,
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: `lich up dev:env-override` — non-default named profile.
  // -----------------------------------------------------------------------
  describe("lich up dev:env-override (non-default profile that extends dev)", () => {
    let fix: Fixture | null = null;
    let didUp = false;

    it(
      "(setup) brings up the dogfood-stack under the `dev:env-override` profile",
      () => {
        fix = makeFixture("profiles-named-override", true);
        const upResult = runLich(["up", "dev:env-override"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          timeout: 240_000,
        });
        // dev:env-override intentionally overrides DATABASE_URL to a
        // non-resolving hostname (db.test.example.com). The dogfood yaml
        // documents this: "e2e coverage asserts on the env Lich resolved,
        // not on actually opening a DB connection." Consequence: the api
        // service returns 500 for any route that touches the DB, the web
        // service's `/` page renders that 500, web's `ready_when.http_get`
        // never sees a 200, and `lich up` exits non-zero.
        //
        // That's fine for this test — the assertion in the next it() block
        // is about the snapshot's `active_profile`, which gets written at
        // the start of `runUp` (Step 6) BEFORE service ready_when waits.
        // So even a partial-up writes the field we're checking.
        //
        // Mirror the LEV-396 follow-up's pattern (profiles-env-override.test.ts):
        // mark didUp regardless so teardown runs, log a warning on non-zero
        // exit so a real regression (e.g. up dies before snapshot is
        // written) is visible in test output, and let the snapshot
        // assertion do the actual gating.
        didUp = true;
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `lich up dev:env-override exited ${upResult.exitCode} (expected; api can't reach bogus DB). Continuing to active_profile assertion.`,
          );
        }
      },
      300_000,
    );

    it("reports active_profile === 'dev:env-override' via lich stacks --json", () => {
      const active = readActiveProfileViaStacks(fix!);
      expect(active).toBe("dev:env-override");
    });

    it(
      "(teardown) lich down + tmpdir cleanup",
      () => {
        if (fix) teardownFixture(fix, didUp);
        fix = null;
        didUp = false;
      },
      180_000,
    );
  });

  // -----------------------------------------------------------------------
  // Test 3: `lich up <unknown>` — bails before any state mutation with a
  //         clear error that lists declared profiles for the user.
  // -----------------------------------------------------------------------
  it("lich up <unknown> exits non-zero with a helpful error listing declared profiles", () => {
    // No `install: true` and no docker work — this path errors out during
    // profile resolution, well before port allocation. Fixture is just the
    // yaml file + an empty LICH_HOME.
    const fix = makeFixture("profiles-named-unknown", false);
    try {
      const result = runLich(["up", "totally-not-a-profile"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        // Should be sub-second; the 30s default in runLich is generous.
      });

      // Exit code 1 — `lich up` with an unknown profile is a hard error.
      expect(result.exitCode).toBe(1);

      // The pretty-output `error` block routes through the pretty renderer
      // which writes to the configured `stream` (stdout by default). The
      // task spec mentions "stderr" but the actual binary writes the error
      // banner to stdout in pretty mode — we assert on the merged content
      // so we're robust to either routing.
      const combined = `${result.stdout}\n${result.stderr}`;

      // The error names the requested profile so the user immediately sees
      // their typo in the output.
      expect(combined).toContain("no profile named 'totally-not-a-profile'");

      // The error lists every declared profile so the user can correct.
      // dogfood-stack/lich.yaml declares `dev` and `dev:env-override`; both
      // must appear so the user can pick one (or fix the typo).
      expect(combined).toContain("dev");
      expect(combined).toContain("dev:env-override");

      // Sentinel: the unknown-profile path runs BEFORE any state mutation,
      // so the LICH_HOME's stacks/ directory must be empty (no state.json
      // was created — failing here would mean the bail-early ordering
      // regressed).
      const stacksDir = join(fix.lichHome, "stacks");
      if (existsSync(stacksDir)) {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const entries = readdirSync(stacksDir);
        expect(
          entries,
          `unknown-profile path must not write any state.json; saw stack dirs: ${entries.join(", ")}`,
        ).toEqual([]);
      }
    } finally {
      teardownFixture(fix, false);
    }
  });
});
