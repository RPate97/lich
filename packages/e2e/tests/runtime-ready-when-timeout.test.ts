
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
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { readStateJson } from "../helpers/state.js";
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
// Fixture + helpers
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

/**
 * The minimal lich.yaml this test writes over the dogfood-stack copy.
 *
 *   - `runtime.ready_when_timeout: 3s` — the LEV-494 stack-wide default.
 *     Both owned services inherit this value because neither writes a
 *     per-service `ready_when.timeout`.
 *
 *   - `hang_tcp` — `cmd: 'sleep 99999'`, `ready_when.tcp: 'localhost:1'`.
 *     Port 1 is reserved + never bound, so the probe loops forever; the
 *     3s runtime default fires and the service is marked failed. The
 *     wall-clock observation of "abort happened within ~10s, not ~60s+"
 *     is the load-bearing proof that the runtime default actually took
 *     effect.
 *
 *   - `quick_ready` — `cmd: 'echo "I am ready"; sleep 99999'`,
 *     `ready_when.log_match: "I am ready"`. Becomes ready in <1s. This
 *     is the "scoped failure" sentinel — proves the timeout is per-
 *     service, not stack-wide cancellation.
 *
 * Both services have no `depends_on`, so they share level 0 and start in
 * parallel — `Promise.allSettled` per level is what enables the scoped-
 * failure assertion (one service can fail while the other reaches ready).
 *
 * Indentation matches the dogfood-stack convention (two spaces).
 */
const MINIMAL_LICH_YAML = `version: "1"

runtime:
  # LEV-494 — stack-wide default for owned services' ready_when.timeout.
  # hang_tcp below inherits this (no per-service timeout). 3s keeps the
  # test's wall-clock budget tight (~10s with orchestrator overhead).
  ready_when_timeout: 3s

owned:
  # LEV-494 sentinel: this service has NO per-service ready_when.timeout
  # — it inherits the 3s default from runtime.ready_when_timeout above.
  # The tcp probe targets port 1 (reserved + unbound on every platform),
  # so the probe loops forever and the runtime default's 3s fires.
  hang_tcp:
    cmd: 'sleep 99999'
    ready_when:
      tcp: 'localhost:1'

  # LEV-494 companion sentinel: becomes ready in ~100ms via log_match,
  # proving the timeout failure on hang_tcp is scoped per-service (not
  # stack-wide cancellation). Also has no per-service timeout, so it
  # would inherit the 3s — but it never hits the deadline.
  quick_ready:
    cmd: 'echo "I am ready"; sleep 99999'
    ready_when:
      log_match: "I am ready"
`;

function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack");
  writeFileSync(join(stack.path, "lich.yaml"), MINIMAL_LICH_YAML, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-runtime-ready-timeout-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  // Best-effort `lich down` — same rationale as
  // `failure-ready-timeout.test.ts`: per-service failure leaves supervised
  // processes for `lich down` to reap. A failure here is logged but never
  // thrown so it can't mask the test result.
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

describe("lich up — runtime.ready_when_timeout default (LEV-494)", () => {
  it(
    "applies the runtime default to owned services without a per-service timeout",
    () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // ---- validate precheck --------------------------------------------
      // The minimal yaml uses the new `runtime.ready_when_timeout` key.
      // A failure here means either the schema didn't accept it or the
      // dist binary was built from a tree that's missing LEV-494 — surface
      // the diagnostic loudly so the rest of the test isn't a mystery.
      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      if (validateResult.exitCode !== 0) {
        throw new Error(
          `minimal lich.yaml failed validate — runtime.ready_when_timeout ` +
            `schema regression or stale binary.\n` +
            `--- validate stdout ---\n${validateResult.stdout}\n` +
            `--- validate stderr ---\n${validateResult.stderr}`,
        );
      }

      // ---- Run `lich up` ------------------------------------------------
      // Wall-clock budget: the 3s runtime default plus a few seconds for
      // level coordination / failure rendering / state.json persistence.
      // If LEV-494 weren't wired, the built-in 60s default would fire
      // instead — the 20s ceiling below catches that regression.
      const t0 = Date.now();
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsedMs = Date.now() - t0;

      // ---- Exit code ----------------------------------------------------
      // `lich up` MUST exit non-zero — the per-service failure path bubbles
      // through Promise.allSettled into `exitCode: 1`. Anything else means
      // the timeout machinery silently swallowed the failure.
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected success — stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected success — stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);

      // ---- Wall-clock budget (the load-bearing LEV-494 assertion) -------
      // The runtime default's 3s plus ~7s orchestrator overhead is the
      // ceiling. Without LEV-494, the built-in 60s default would fire and
      // this assertion would catch the regression instantly.
      //
      // Use a looser 20s ceiling so the test stays robust on a loaded CI
      // runner while still being well under the 60s built-in default.
      expect(
        elapsedMs,
        `lich up took ${elapsedMs}ms (budget 20s); runtime.ready_when_timeout ` +
          `should fire at ~3s, not at the built-in 60s default`,
      ).toBeLessThan(20_000);

      // ---- Output: failure block contents -------------------------------
      const combined = upResult.stdout + upResult.stderr;

      // Service name in the failure block.
      expect(combined).toContain("hang_tcp");

      // Timeout marker — the reason string shape is the same regardless of
      // which knob set the timeout value (`"ready_when did not satisfy
      // within 3s (tcp)"`). The "within 3s" substring proves the runtime
      // default's 3s value actually flowed into the ReadyTimeoutError —
      // not some other timeout (e.g. the 30s spawn ceiling).
      expect(combined).toContain("within 3s");

      // ---- state.json: hang_tcp failed, quick_ready not failed ----------
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

      // Stack-level status: per-level failure → `markStackFailed` →
      // `status: "failed"`.
      expect(snap!.status).toBe("failed");

      // Per-service: hang_tcp is failed with failure_reason populated.
      // The failure_reason must reference "3s" — that's the value the
      // runtime default contributed to the chain. A regression where the
      // built-in 60s leaked through despite the runtime override would
      // show "within 60s" here instead.
      const hangSnap = snap!.services.find((s) => s.name === "hang_tcp");
      expect(
        hangSnap,
        `hang_tcp missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(hangSnap!.state).toBe("failed");

      // Cast to read the failure fields not enumerated on the helper's
      // shape (added by Plan 4 Task 10 on the lich side; mirrors the
      // approach in failure-ready-timeout.test.ts).
      const hangSnapWithFailure = hangSnap as typeof hangSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(
        hangSnapWithFailure.failure_reason,
        `hang_tcp.failure_reason was not populated — Task 14's classifier ` +
          `or Task 10's snapshot writer regressed`,
      ).toBeDefined();
      // The "within 3s" substring is shared between the formatter's title
      // ("did not become ready in 3s") and the reason line ("ready_when
      // did not satisfy within 3s (tcp)"); asserting on the reason string
      // (which is what state.json carries) keeps the assertion specific.
      expect(hangSnapWithFailure.failure_reason).toContain("within 3s");

      // quick_ready: NOT failed. The runtime default applied to it too,
      // but it became ready in ~100ms via log_match — well within the 3s
      // budget. This proves the timeout is per-service, not stack-wide,
      // even though the value came from a stack-wide knob.
      const quickSnap = snap!.services.find((s) => s.name === "quick_ready");
      expect(
        quickSnap,
        `quick_ready missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(
        quickSnap!.state,
        `quick_ready state must not be "failed" — it should have become ` +
          `ready well within the 3s runtime default; got "${quickSnap!.state}"`,
      ).not.toBe("failed");

      const quickSnapWithFailure = quickSnap as typeof quickSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(quickSnapWithFailure.failure_reason).toBeUndefined();
    },
    // 60s per-test ceiling: runLich gets 30s + 30s of teardown slack. Well
    // below the suite-wide vitest default.
    60_000,
  );
});
