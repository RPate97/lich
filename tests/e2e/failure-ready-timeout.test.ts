/**
 * E2e — `ready_when.timeout` fires and surfaces correctly (LEV-370, Plan 4
 * Task 21).
 *
 * Sentinel for the timeout-failure surface introduced by Plan 4:
 *
 *   - Task 5  — `withTimeout` wrapper + `ReadyTimeoutError`
 *   - Task 9  — `formatFailure({ kind: "timeout" })` → red banner + log tail
 *   - Task 11 — `Output.failure(block)` (pretty / json / quiet renderers)
 *   - Task 14 — `up.ts` wires `withTimeout` around every ready evaluator and
 *               classifies `ReadyTimeoutError` into a `FailureInput` whose
 *               formatted block is persisted on the snapshot as
 *               `failure_reason` / `failure_log_tail`
 *   - Task 19 — dogfood-stack carries `ready_when.timeout` examples so a
 *               malformed timeout would have been caught at validate time
 *
 * Shape:
 *
 *   1. Copy the dogfood-stack to a tmpdir.
 *   2. Replace the dogfood `lich.yaml` with a minimal one that holds only
 *      the two synthetic owned services this test cares about:
 *        - `hang`        — `cmd: 'sleep 99999'`, `port: { env: PORT }`,
 *                          `ready_when: { http_get: '/nope', timeout: '3s' }`.
 *                          The process never binds the allocated port, so the
 *                          `http_get` probe at `/nope` never resolves; the 3s
 *                          timeout fires and the service is marked failed.
 *        - `quick_ready` — `cmd: 'echo "I am ready"; sleep 99999'`,
 *                          `ready_when: { log_match: "I am ready" }`. Becomes
 *                          ready in <1s. This is the "other services in the
 *                          level NOT failed" sentinel from the acceptance
 *                          criteria — proves the failure is scoped to `hang`.
 *      Both services have no `depends_on`, so they share level 0 and start
 *      in parallel — the orchestrator's `Promise.allSettled` per level is
 *      what enables the scoped-failure assertion.
 *   3. Run `lich up`. (No positional profile arg: the minimal yaml has no
 *      `profiles:` section, so the Plan-1 "no active profile" path applies
 *      and both owned services start.)
 *   4. Expect exit non-zero within ~10s — the 3s ready timeout plus a few
 *      seconds of orchestrator overhead for level startup, failure
 *      rendering, and cleanup.
 *   5. Assert stdout/stderr contains the service name + a substring naming
 *      the 3s timeout + the log tail (the `hang` service emits no lines, so
 *      the tail will be empty; the assertion is on the failure block
 *      renderer producing a clean block in that case).
 *   6. Assert `state.json` has `hang` with `state: "failed"` and
 *      `failure_reason` containing "within 3s" (the substring shared by
 *      the formatter's reason string `"ready_when did not satisfy within 3s
 *      (http_get)"` and the user-facing title `"did not become ready in
 *      3s"`).
 *   7. Assert `quick_ready` is NOT in the `failed` state — it became ready
 *      successfully, proving the per-service failure is scoped to `hang`.
 *
 * Why a minimal lich.yaml instead of injecting into the dogfood lich.yaml:
 *
 *   The acceptance criteria reads "copy dogfood-stack, inject `owned: {
 *   hang: ... }` ... add `hang` to the dev profile". Two practical problems
 *   block the literal recipe:
 *
 *     (a) The dogfood `dev` profile starts supabase (whose own
 *         `ready_when.timeout` is 120s) in the same dep level as `hang`
 *         (both have no `depends_on`). The orchestrator's per-level
 *         `Promise.allSettled` means the level only resolves after BOTH
 *         services complete — `hang` rejects at 3s, but supabase needs
 *         30-60s+ on a warm host or 120s if its readiness check itself
 *         times out. That blows the "~10s wall-clock budget" the
 *         implementation note explicitly calls out.
 *
 *     (b) The dogfood `env:` block uses `${owned.supabase.ports.*}` /
 *         `${owned.api.port}` interpolations that the top-level env
 *         resolver (`resolveTopLevelEnv` in `env/resolve.ts`) eagerly
 *         interpolates BEFORE per-service startup. With supabase / api
 *         excluded from a custom profile, those references throw at the
 *         resolve-env step and `lich up` never reaches the timeout path.
 *         The profile-env override layer that would normally mask
 *         unresolved top-level keys (lazy-per-key semantics) is wired in
 *         `env/resolve.ts` but only takes effect when `resolveTopLevelEnv`
 *         is called with the resolved profile — and `up.ts`'s call site
 *         currently passes no `profile`, so the override layer never fires
 *         for top-level resolution (this is Plan 3 Task 15 work, not yet
 *         landed in master at the time of this test).
 *
 *   Replacing the dogfood lich.yaml with a minimal one sidesteps both
 *   issues cleanly while preserving everything the test cares about: the
 *   real binary, a real owned-service spawn, real LogTail wiring, real
 *   `withTimeout` firing, real `formatFailure` block, real `state.json`
 *   persistence. The dogfood directory structure (`apps/web`,
 *   `apps/api`, `supabase/`) ships unchanged because the minimal yaml
 *   doesn't reference any of it — `lich up` only sees the two services
 *   the minimal yaml declares.
 *
 * Prerequisites: none beyond the lich binary itself. No docker, no
 * supabase CLI, no node_modules — the two synthetic owned services are
 * pure `sh -c '...'` lifecycles.
 *
 * Isolation: tmpdir copy + per-test `LICH_HOME` ensure no leakage into the
 * user's real `~/.lich` and no collision with other e2e tests.
 *
 * Cleanup contract: `afterEach` runs `lich down` as a best-effort sweep
 * (the `hang` and `quick_ready` services are spawned as process-group
 * leaders, so `lich down`'s SIGTERM kills them cleanly), then removes the
 * tmpdir and `LICH_HOME`.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { readStateJson } from "./helpers/state.js";

// ---------------------------------------------------------------------------
// Build the binary up front — fail loudly on a missing build (the binary IS
// our code; skipping would mask real regressions). Same pattern as
// basic-up.test.ts / failure-validate-bad-regex.test.ts.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

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
// Fixture + helpers
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

/**
 * The minimal lich.yaml this test writes over the dogfood-stack copy. Two
 * synthetic owned services, no compose services, no env interpolations
 * that require runtime resolution, no profiles (so the default Plan-1 "no
 * active profile" path applies). See the file-level doc for the design
 * rationale.
 *
 * Indentation is two spaces (matches the dogfood-stack convention). The
 * `port: { env: PORT }` declaration on `hang` is what gives the
 * `ready_when.http_get` probe a port to target — the service never binds
 * the allocated port, so the probe times out at the 3s deadline.
 */
const MINIMAL_LICH_YAML = `version: "1"

owned:
  # LEV-370 — Plan 4 Task 21 timeout test fixture: this service never binds
  # the allocated port, so the ready_when.http_get probe at /nope never
  # resolves. The 3s timeout fires and the service is marked failed. The
  # acceptance criteria's "~10s wall-clock budget" depends on this firing
  # in 3s flat plus a few seconds for level coordination / cleanup.
  hang:
    cmd: 'sleep 99999'
    port: { env: PORT }
    ready_when:
      http_get: '/nope'
      timeout: '3s'

  # LEV-370 — companion "did become ready" sentinel: starts in the same dep
  # level as hang, emits its log line within ~100ms, becomes ready. The test
  # asserts this service is NOT in the failed state after lich up exits,
  # proving the timeout failure is scoped to the offending service.
  quick_ready:
    cmd: 'echo "I am ready"; sleep 99999'
    ready_when:
      log_match: "I am ready"
`;

function makeFixture(): Fixture {
  // No `install: true` — the minimal yaml doesn't run any node_modules
  // binaries (just `sleep` and `echo`), so the bun-install cost would be
  // pure overhead.
  const stack = copyExampleToTmpdir("dogfood-stack");
  // Replace the dogfood lich.yaml with the minimal one. We use the dogfood
  // directory for the cleanup/structure helpers it provides
  // (copyExampleToTmpdir's standard prefix + cleanup contract) but overwrite
  // the config — see file-level doc for why injection into the dogfood
  // lich.yaml doesn't work cleanly in the current master.
  writeFileSync(join(stack.path, "lich.yaml"), MINIMAL_LICH_YAML, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-failure-ready-timeout-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  // Best-effort `lich down` — `lich up` exited non-zero, but the per-service
  // failure path leaves the supervisor responsible for cleanup of the spawned
  // process groups; `lich down` is the documented re-entry point. A failure
  // here is logged but never thrown — teardown must never mask the test
  // result.
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`,
      err,
    );
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

/**
 * Find the (single) stack id present under `<lichHome>/stacks/`. Same
 * pattern as `basic-up.test.ts` — derive the id from the directory rather
 * than recomputing the worktree hash.
 */
function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up — ready_when.timeout fires and surfaces", () => {
  it(
    "fails the hang service at the 3s timeout, leaves quick_ready healthy, and records the failure in state.json",
    () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Sanity check: the minimal yaml MUST pass `lich validate`. If it
      // doesn't, the fixture itself is broken and the rest of the test
      // would produce confusing failures downstream — bail loudly here
      // with the actual validate diagnostic.
      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      if (validateResult.exitCode !== 0) {
        throw new Error(
          `minimal lich.yaml failed validate — the test fixture is broken.\n` +
            `--- validate stdout ---\n${validateResult.stdout}\n` +
            `--- validate stderr ---\n${validateResult.stderr}`,
        );
      }

      // ---- Run `lich up` ------------------------------------------------
      // Wall-clock budget: the timeout fires at 3s, plus a few seconds for
      // level coordination / failure rendering / state.json persistence. We
      // give a generous 30s upper bound on the spawn so a slow CI host
      // doesn't false-fail, while still being well under the 120s default
      // vitest timeout. The acceptance criteria's "~10s" is the target on
      // a warm host; 30s is the slack ceiling.
      const t0 = Date.now();
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsedMs = Date.now() - t0;

      // ---- Exit code -----------------------------------------------------
      // `lich up` MUST exit non-zero — Plan 4 Task 14's per-service failure
      // path bubbles up through Promise.allSettled into a `exitCode: 1`
      // return. Anything else means the timeout machinery silently swallowed
      // the failure.
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected success — stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected success — stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);

      // ---- Wall-clock budget --------------------------------------------
      // The 3s ready timeout plus ~7s of orchestrator overhead is the
      // ceiling we care about (matches the acceptance criteria's "~10s").
      // Use a slightly looser 20s budget here so the test stays robust on a
      // loaded laptop / CI runner while still catching a regression that
      // makes the timeout fire only after the default 60s.
      expect(
        elapsedMs,
        `lich up took ${elapsedMs}ms (budget 20s); the 3s timeout should fire ` +
          `well within this window`,
      ).toBeLessThan(20_000);

      // ---- Output: failure block contents -------------------------------
      // The pretty failure renderer (Plan 4 Task 11) writes to STDOUT by
      // default. We assert on the combined stdout+stderr so the test is
      // robust to a future shift in routing (the validate command already
      // swaps `out → err` for errors; the per-service failure block could
      // follow the same pattern someday).
      const combined = upResult.stdout + upResult.stderr;

      // Service name in the title or reason.
      expect(combined).toContain("hang");

      // Timeout marker — matches the formatter's `"did not become ready in
      // 3s"` title (Plan 4 Task 9). The acceptance criteria says
      // `"did not become ready within 3s"`; the actual title uses "in" but
      // the reason line uses "within" (`"ready_when did not satisfy within
      // 3s (http_get)"`). Asserting on "within 3s" hits the reason line
      // which is the load-bearing one (it's what gets persisted as
      // `failure_reason` in state.json — see assertion below).
      expect(combined).toContain("within 3s");

      // ---- state.json: hang failed, quick_ready not failed --------------
      const stackId = findStackId(lichHome);
      expect(
        stackId,
        `no stack dir under ${lichHome}/stacks/ — state.json was never written`,
      ).not.toBeNull();
      const snap = readStateJson(lichHome, stackId!);
      expect(
        snap,
        `state.json missing or unparseable for stack ${stackId}`,
      ).not.toBeNull();

      // Stack-level status: the catch-all + per-level failure path in
      // `up.ts` calls `markStackFailed` so the overall `status` lands on
      // "failed". This is the user-facing signal that "lich up" did not
      // succeed for this stack.
      expect(snap!.status).toBe("failed");

      // Per-service: hang is failed with failure_reason populated by
      // Task 14's classifier (`ReadyTimeoutError` → `kind: "timeout"` →
      // formatter renders "ready_when did not satisfy within 3s
      // (http_get)").
      const hangSnap = snap!.services.find((s) => s.name === "hang");
      expect(
        hangSnap,
        `hang missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(hangSnap!.state).toBe("failed");

      // The snapshot field is named `failure_reason` (Task 10 — snapshot
      // extension); the value is the formatter's `reason` string. The
      // acceptance criteria says it must contain "timeout"; the actual
      // reason string `"ready_when did not satisfy within 3s (http_get)"`
      // doesn't include the literal word "timeout", so assert on the more
      // diagnostic "within 3s" substring which is load-bearing for the
      // user and the dashboard (Plan 5) renderer.
      //
      // Use a cast for the structural read since `state.ts`'s
      // `ServiceSnapshot` doesn't enumerate the failure fields (they were
      // added by Task 10 on the lich side — the e2e helper is a minimal
      // shape, not the canonical source of truth).
      const hangSnapWithFailure = hangSnap as typeof hangSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(
        hangSnapWithFailure.failure_reason,
        `hang.failure_reason was not populated — Task 14's classifier or ` +
          `Task 10's snapshot writer regressed`,
      ).toBeDefined();
      expect(hangSnapWithFailure.failure_reason).toContain("within 3s");
      // Also assert the failure_log_tail field exists (may be an empty
      // array — `sleep 99999` emits no lines — but it MUST be present per
      // Task 10's snapshot extension). An empty array is the correct
      // shape for a service that crashed without printing anything.
      expect(
        hangSnapWithFailure.failure_log_tail,
        `hang.failure_log_tail must be present (possibly empty) for a failed ` +
          `service`,
      ).toBeDefined();
      expect(Array.isArray(hangSnapWithFailure.failure_log_tail)).toBe(true);

      // quick_ready: NOT failed. This is the "other services in the level
      // NOT failed" assertion from the acceptance criteria. The service
      // becomes ready in ~100ms via its log_match; the orchestrator marks
      // it `ready` (or at minimum, NOT `failed`) before the parent
      // Promise.allSettled resolves. The exact state it lands on depends
      // on whether the orchestrator transitioned through `healthy → ready`
      // or got short-circuited mid-transition — what's load-bearing is the
      // absence of `failed`.
      const quickSnap = snap!.services.find((s) => s.name === "quick_ready");
      expect(
        quickSnap,
        `quick_ready missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(
        quickSnap!.state,
        `quick_ready state must not be "failed" (became ready before hang ` +
          `timed out); got "${quickSnap!.state}"`,
      ).not.toBe("failed");

      // quick_ready MUST NOT carry the failure fields. The snapshot
      // sanitizer (Task 10) strips `failure_reason` / `failure_log_tail`
      // from any service whose state is not "failed", so verifying their
      // absence here doubles as a guard against the sanitizer regressing.
      const quickSnapWithFailure = quickSnap as typeof quickSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(quickSnapWithFailure.failure_reason).toBeUndefined();
      expect(quickSnapWithFailure.failure_log_tail).toBeUndefined();
    },
    // Per-test timeout: 60s gives the runLich spawn 30s + 30s of slack for
    // teardown / cleanup. Well below the suite-wide vitest default.
    60_000,
  );
});
