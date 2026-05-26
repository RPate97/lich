/**
 * Plan 3 Task 24 (LEV-398) — switching profiles mid-flight is refused.
 *
 * Pins the contract from Plan 3 Task 13 (LEV-387): once a stack is up under
 * some profile, a second `lich up` invocation against the SAME worktree
 * MUST fail rather than silently swap profiles (or silently no-op when the
 * profile name matches). Both cases produce an "already up" error and the
 * existing stack stays running — the refuse path is read-only on every
 * piece of stack state (no port reservations move, no compose override
 * rewrites, no snapshot mutations).
 *
 * Two test groups:
 *
 *   1. `lich up <other> while up under <first> is refused`
 *      Bring a stack up under `dev`. Run `lich up dev:env-override` against
 *      the same worktree. Assert exit 1 + combined output mentions
 *      "already up" AND both profile names (so the operator immediately
 *      sees what's running and what they tried to switch to). Verify via
 *      `lich stacks --json` that `active_profile` is still `"dev"` AND the
 *      stack status is still `"up"` — i.e. the refuse path didn't quietly
 *      half-tear-down. Down + cleanup.
 *
 *   2. `lich up <same> while up under <same> is refused with a sensible error`
 *      Bring a stack up under `dev`. Run `lich up dev` again. Assert exit 1
 *      + combined output mentions "already up". This pins the spec decision
 *      that re-up under the same profile is NOT a no-op — Plan 1 has no
 *      idempotent re-up semantics, and Plan 3 inherits that. If the team
 *      ever flips this to be idempotent, this test flags the spec change
 *      loudly.
 *
 * Why a synthetic minimal yaml (not the dogfood-stack):
 *
 *   The refuse-mid-flight contract is checked in up.ts BEFORE port
 *   allocation, BEFORE compose override generation, BEFORE any service
 *   spawn. The check reads state.json and compares `priorSnap.status`
 *   (must be "up" or "starting") and `priorSnap.active_profile` against
 *   the requested profile. It is entirely independent of WHICH services
 *   are running — a stack with one trivial sleep-based owned service
 *   exercises the same code path as the full dogfood stack.
 *
 *   Using a synthetic yaml keeps this test:
 *     - Hermetic: no docker, no network. The test relies only on the
 *       lich binary and a shell.
 *     - Fast: sub-10s per case versus 30s+ for the dogfood-stack.
 *     - Decoupled from unrelated environmental issues: a flaky lifecycle
 *       hook (e.g. the psql migration failing on cert mismatch) cannot
 *       cause this test to misreport.
 *
 *   The owned service is a single `sleep 600` — it stays alive for 10
 *   minutes, well past the test's runtime. No ports, no deps, no
 *   ready_when (lich treats absent ready_when as immediately-ready after
 *   the 100ms post-spawn liveness probe), no lifecycle hooks. The stack
 *   reaches `status: up` within a few hundred ms of `lich up` returning.
 *
 *   The dogfood-stack is the right tool for the parallel-stacks sentinel
 *   (Task 26) and the lifecycle-scoping test (Task 23) — both of those
 *   need the full service graph to exercise their contracts. This test
 *   does not.
 *
 * Routing note:
 *   The refuse error is emitted via `output.error(...)` in `up.ts`, which
 *   routes through the pretty renderer to the configured stream (stdout
 *   by default — same routing as `profiles-named.test.ts`'s
 *   unknown-profile error). The task description mentions "stderr" but
 *   the binary writes the banner to stdout in pretty mode. The
 *   assertions check the combined stdout+stderr text so they're robust
 *   to either channel — pinning "the user-visible output contains the
 *   keyword", not which fd it lands on.
 *
 * Isolation:
 *   - Synthetic tmpdir per test (fresh mkdtempSync, no example copy).
 *   - LICH_HOME under a per-test tmpdir so ports.json / stacks/ are
 *     private to this test and the user's real `~/.lich` is untouched.
 *   - lich binary built in `beforeAll` from packages/lich/ (fail-loud).
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich down --yes` runs in a teardown `it()` block even when the
 *     body throws so the sleep-based owned process doesn't outlive the
 *     test. (down is sufficient here — no docker resources to nuke,
 *     and the per-test LICH_HOME is exclusive so down's per-stack scope
 *     is fine.)
 *   - tmpdir + LICH_HOME removed in the same teardown block.
 *
 * Setup/teardown live inside `it()` blocks (matching env-groups-isolation,
 * logs, and profiles-named e2e tests) rather than beforeAll/afterAll so
 * each step gets a generous per-it timeout — Bun's default hook timeout
 * is too tight for any teardown that needs more than a few seconds.
 *
 * Pool classification (e2e-suite-solid-and-fast design): FAST.
 *   - Synthetic yaml with a sleep-based owned service; no docker, no
 *     postgres, no DATABASE_URL, no /health probe — nothing that the
 *     dev:fast default flip affects. The `dev` profile referenced in the
 *     `lich up dev` calls is THIS test's own synthetic profile, not the
 *     dogfood-stack's `dev`.
 *   - No expectDbMode call because the test never hits /health; the
 *     refuse-mid-flight contract is exercised purely through state.json
 *     and `lich stacks --json`.
 *   - No service-name array assertions to flip from
 *     `["api", "postgres", "tunnel_demo", "web"]` to `["api", "web"]`.
 *   - Runs in parallel forks without conflict because each describe owns
 *     its own LICH_HOME via `makeFixture`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail-loud — the binary is OUR code; a broken
// build is a real bug, not something to skip past. Mirrors the pattern in
// basic-up.test.ts, profiles-named.test.ts, and failure-process-exit.test.ts.
// ---------------------------------------------------------------------------


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
// Shared types
// ---------------------------------------------------------------------------

/**
 * The shape `lich stacks --json` emits. Mirrors the inline `JsonRow` in
 * `packages/lich/src/commands/stacks.ts`. `active_profile` is optional
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

// ---------------------------------------------------------------------------
// Test yaml — single sleep-based owned service, two profiles
// ---------------------------------------------------------------------------

/**
 * Minimal yaml that exercises the refuse-mid-flight contract without any
 * docker dependency. Two profiles:
 *
 *   - `dev` (default: true) — runs the `keepalive` service.
 *   - `dev:env-override` (extends: dev) — same service set, an env override.
 *     Mirrors the dogfood-stack's two-profile shape (`dev` + `dev:env-override`
 *     extending it with an env override) so the test exercises the same
 *     resolver path the real config uses.
 *
 * The `keepalive` owned service:
 *   - `cmd: 'sleep 600'` — stays alive 10 minutes, well past the test's
 *     runtime. The supervisor's 100ms post-spawn liveness probe sees it
 *     still alive and marks the service ready (no `ready_when` declared).
 *   - No `port`, no `depends_on`, no lifecycle hooks. Single-level dep
 *     graph → fastest possible up-to-ready transition.
 *
 * Within ~500ms of `lich up dev`, `state.json` reads `status: "up"` +
 * `active_profile: "dev"` — exactly the state the refuse-mid-flight
 * branch tests against.
 */
const REFUSE_TEST_YAML = `version: "1"

owned:
  keepalive:
    # Sleep for 10 minutes — long enough that no test in this file can
    # outlive the process. The supervisor's post-spawn liveness probe (see
    # up.ts:waitReady's 100ms checkExitedNow) sees the process still alive
    # at t=100ms and marks it ready. No ready_when → no log/http/tcp poll.
    # No stop_cmd → supervisor signals the process group on lich down (the
    # standard SIGTERM → SIGKILL escalation, recently fixed in 8850409
    # "fix(owned): spawn services as process-group leaders").
    cmd: 'sleep 600'

profiles:
  dev:
    default: true
    owned: [keepalive]

  # Mirrors the dogfood-stack's "dev:env-override extends dev" shape. The
  # env override here is purely shape-coverage — the refuse contract is
  # exercised by the profile NAME mismatch, not by what env-override would
  # have layered in.
  dev:env-override:
    extends: dev
    env:
      SOME_FLAG: "overridden"
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  lichHome: string;
}

/**
 * Build a fresh fixture: a tmpdir with the `REFUSE_TEST_YAML` written as
 * `lich.yaml`, plus a separate per-test LICH_HOME. Mirrors the
 * `failure-process-exit.test.ts` pattern of writing a synthetic yaml,
 * minus the example-copy (we don't need apps/ or db/ siblings).
 */
function makeFixture(prefix: string): Fixture {
  const stackPath = mkdtempSync(join(tmpdir(), `lich-e2e-${prefix}-`));
  writeFileSync(join(stackPath, "lich.yaml"), REFUSE_TEST_YAML, "utf8");
  const lichHome = mkdtempSync(join(tmpdir(), `lich-e2e-${prefix}-home-`));
  return { stackPath, lichHome };
}

/**
 * Best-effort teardown. Always run `lich down --yes` so the sleep-based
 * owned process is signaled cleanly, then remove the tmpdir + LICH_HOME.
 * Failures are warned (CI surfaces leaks) but never thrown — teardown
 * must not mask a real test result.
 */
function teardownFixture(fix: Fixture, didUp: boolean): void {
  if (didUp) {
    try {
      runLich(["down", "--yes"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        timeout: 30_000,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`teardown lich down failed for ${fix.stackPath}:`, err);
    }
  }
  try {
    rmSync(fix.stackPath, { recursive: true, force: true });
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

/**
 * Run `lich stacks --json` against the per-test LICH_HOME and return the
 * single matching row. Throws on parse failure or unexpected row count —
 * both are real bugs to surface.
 *
 * Mirrors the same-named helper in profiles-named.test.ts. Kept inline
 * rather than extracted to a shared helper because the two callers' row
 * shapes have diverged slightly (this one needs `status` too).
 */
function readStacksRow(fix: Fixture): StacksJsonRow {
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
  // basename. LICH_HOME is per-test so typically only one row exists; the
  // filter is defensive against orphan entries (which shouldn't happen but
  // can if a prior test leaked).
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
  return matches[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up <other> while up under <first> is refused (Plan 3 Task 24)", () => {
  let fix: Fixture | null = null;
  let didUp = false;

  it(
    "(setup) brings up the synthetic stack under the `dev` profile",
    () => {
      fix = makeFixture("profiles-switch-refused-cross");

      // First up: explicit `dev` profile. The keepalive service is
      // immediately ready (sleep 600 stays alive past the 100ms post-spawn
      // probe), so `lich up` returns quickly with the stack at status:up.
      const upResult = runLich(["up", "dev"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        // Synthetic stack — sub-second under normal conditions. 30s gives
        // ample headroom for cold-cache binary spawn + yaml parse.
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("setup lich up dev stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("setup lich up dev stderr:", upResult.stderr);
        throw new Error(
          `setup lich up dev exited ${upResult.exitCode}; cannot proceed with refuse-switch assertion`,
        );
      }
      didUp = true;
    },
    /* timeout */ 60_000,
  );

  it(
    "refuses `lich up dev:env-override` with exit 1 + both profile names in the error",
    () => {
      const result = runLich(["up", "dev:env-override"], {
        cwd: fix!.stackPath,
        env: { LICH_HOME: fix!.lichHome },
        // The refuse path is read-only — no docker, no port allocation. It
        // bails after snapshot read + comparison. Should be sub-second;
        // the 30s default in runLich is generous.
      });

      // Exit code 1 is the contract — refuse-mid-flight is a hard error,
      // not a no-op or a partial swap.
      expect(
        result.exitCode,
        `combined output:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ).toBe(1);

      const combined = `${result.stdout}\n${result.stderr}`;

      // The user-visible text MUST contain "already up" (case-insensitive,
      // since the error banner format may upcase the title in some output
      // modes). The implementation in up.ts uses the literal "already up"
      // in both title and detail.
      expect(combined.toLowerCase()).toContain("already up");

      // Both profile names appear so the operator sees what's running AND
      // what they tried to switch to. The detail message in up.ts reads:
      //   "stack is already up under profile 'dev'; run 'lich down' before
      //    switching to profile 'dev:env-override'"
      // — both names quoted on the same line, so even a downstream wrapper
      // that line-wraps the banner preserves the two names somewhere in
      // the rendered text.
      expect(combined).toContain("dev");
      expect(combined).toContain("dev:env-override");
    },
    /* timeout */ 30_000,
  );

  it(
    "leaves the original stack running under `dev` (refuse path is read-only)",
    () => {
      const row = readStacksRow(fix!);
      // Sanity: status must still be "up". If the refuse path ever started
      // half-tearing-down before refusing (a real regression), this would
      // catch it before the active_profile assertion (which would also
      // fail, but less informatively).
      expect(row.status).toBe("up");
      // The load-bearing assertion: the original profile is intact. Refuse
      // didn't quietly swap the recorded profile to the rejected one.
      expect(row.active_profile).toBe("dev");
    },
    /* timeout */ 30_000,
  );

  it(
    "(teardown) lich down + remove tmpdirs",
    () => {
      if (fix) teardownFixture(fix, didUp);
      fix = null;
      didUp = false;
    },
    /* timeout */ 60_000,
  );
});

describe("lich up <same> while up under <same> is refused (Plan 3 Task 24)", () => {
  let fix: Fixture | null = null;
  let didUp = false;

  it(
    "(setup) brings up the synthetic stack under the `dev` profile",
    () => {
      fix = makeFixture("profiles-switch-refused-same");

      const upResult = runLich(["up", "dev"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("setup lich up dev stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("setup lich up dev stderr:", upResult.stderr);
        throw new Error(
          `setup lich up dev exited ${upResult.exitCode}; cannot proceed with same-profile re-up assertion`,
        );
      }
      didUp = true;
    },
    /* timeout */ 60_000,
  );

  it(
    "refuses a second `lich up dev` with exit 1 + 'already up' in the error",
    () => {
      const result = runLich(["up", "dev"], {
        cwd: fix!.stackPath,
        env: { LICH_HOME: fix!.lichHome },
        // Same as cross-profile case: the refuse path is read-only and
        // bails sub-second. 30s default is generous.
      });

      // Pin Plan 3 Task 13's spec decision: re-up under the SAME profile is
      // NOT a no-op — it's an error. The decision was deliberate ("Plan 1
      // has no idempotent re-up semantics, so neither does Plan 3"). If
      // this test ever needs to flip to expect exit 0, that's a spec
      // change worth a separate Linear issue.
      expect(
        result.exitCode,
        `combined output:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ).toBe(1);

      const combined = `${result.stdout}\n${result.stderr}`;
      // The same-profile case emits the simpler "already up; run 'lich
      // down' first" message — no need to mention two profile names since
      // there's only one in play. The "already up" keyword is the shared
      // sentinel across both cross- and same-profile cases.
      expect(combined.toLowerCase()).toContain("already up");
    },
    /* timeout */ 30_000,
  );

  it(
    "(teardown) lich down + remove tmpdirs",
    () => {
      if (fix) teardownFixture(fix, didUp);
      fix = null;
      didUp = false;
    },
    /* timeout */ 60_000,
  );
});
