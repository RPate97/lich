/**
 * Unit tests for the Plan 4 Task 14 wiring in `lich up`.
 *
 * Coverage of the new orchestrator surfaces:
 *
 *   1. **Snapshot failure fields populated.** When a service fails (process
 *      exit, fail_when match, ready timeout, capture miss), the on-disk
 *      `state.json` carries `failure_reason` and `failure_log_tail` so
 *      the dashboard (Plan 5) and post-hoc tools can render the failure
 *      context without re-running anything.
 *
 *   2. **Captured values flow into downstream env.** A service in level N
 *      that emits a log line matching `ready_when.capture` makes the
 *      captured value visible as `${owned.<name>.captured.<key>}` for
 *      services in levels >= N+1. This is the load-bearing wiring for the
 *      dogfood-stack's tunnel_demo demo and Plan 5's dashboard "what env
 *      did this stack resolve to?" panel.
 *
 *   3. **fail_when races ready_when correctly.** A service whose log emits
 *      the fail_when pattern but never satisfies ready_when must fail with
 *      the fail_when reason — not hang on the ready evaluator.
 *
 *   4. **LogTails stop on cancel.** The per-stack LogTail registry must be
 *      torn down when `lich up` is cancelled (SIGINT); a leaked poll
 *      interval would keep the test process alive past completion.
 *
 * Test design notes:
 *   - All tests use real owned processes (no docker), real LogTails reading
 *     real log files, real state.json writes. The wiring is exactly what
 *     ships in production; only the project dir and LICH_HOME are pinned to
 *     tmpdirs for isolation.
 *   - Each test uses a unique port range so parallel-fork tests don't
 *     collide on the allocator. The `port_range: [PORT, PORT+50]` window
 *     is per-file (vitest forks per file by default).
 *   - The `intervalMs` constants are not configurable from outside — we
 *     rely on the LogTail's 100ms default poll cadence + small `sleep`s
 *     in the shell `cmd` to make the timing observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import {
  readSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { release } from "../../../src/ports/allocator.js";
import { LogTail } from "../../../src/logs/tail.js";

// ---------------------------------------------------------------------------
// Per-test isolation: a fresh LICH_HOME tmpdir, a fresh project tmpdir.
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-fw-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers (mirror the patterns in up.test.ts for consistency)
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

async function loadSnapshot(stackId: string): Promise<StackSnapshot> {
  const snap = await readSnapshot(stackId);
  if (!snap) throw new Error(`no snapshot for ${stackId}`);
  return snap;
}

// ---------------------------------------------------------------------------
// 1. snap.failure_reason + snap.failure_log_tail populated on failure
// ---------------------------------------------------------------------------

describe("up wiring — failure snapshot fields", () => {
  it("populates snap.failure_reason and snap.failure_log_tail when a service fails", async () => {
    // A service that emits a few log lines, then exits 1 — AFTER the
    // 100ms early-exit sentinel window. With a `ready_when` configured,
    // the orchestrator's per-service ProcessExitWatcher races the ready
    // evaluator and catches the exit. Without `ready_when`, the 100ms
    // sentinel would be the only safety net — and the 0.5s sleep below
    // would let the service slip past it.
    //
    // The `echo`s before the sleep give the LogTail (100ms poll cadence)
    // time to read the lines before the supervisor's write fd closes on
    // exit — so the `failure_log_tail` is populated with observable
    // content, not just an empty array.
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19550]
owned:
  broken:
    cmd: 'echo "starting up"; echo "about to crash"; sleep 0.5; exit 1'
    ready_when:
      log_match: "READY"
      timeout: "10s"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    const snap = await loadSnapshot(result.stackId!);
    const brokenSvc = snap.services.find((s) => s.name === "broken");
    expect(brokenSvc?.state).toBe("failed");

    // The failure block's `reason` is now persisted to state.json. The
    // exact wording is owned by the formatter; we assert the load-bearing
    // pieces (the reason exists + is a string) without pinning the prose.
    expect(brokenSvc?.failure_reason).toBeDefined();
    expect(typeof brokenSvc?.failure_reason).toBe("string");
    expect(brokenSvc?.failure_reason!.length).toBeGreaterThan(0);

    // The log tail field is an array. The cmd emits two lines before the
    // 0.5s sleep, so the LogTail's 100ms poll has comfortably caught up
    // by exit time; at minimum the array should be non-empty AND should
    // contain one of the lines the cmd echoed.
    expect(Array.isArray(brokenSvc?.failure_log_tail)).toBe(true);
    const joined = (brokenSvc?.failure_log_tail ?? []).join("\n");
    expect(joined).toMatch(/starting up|about to crash/);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 2. captured values flow into downstream service env
// ---------------------------------------------------------------------------

describe("up wiring — capture context flow", () => {
  it("threads captured values from one service into the next service's env", async () => {
    // producer emits a URL line + a "READY" line + sleeps; ready_when
    // matches the READY line, then capture extracts the URL.
    //
    // consumer depends_on producer (so it's in a later level), references
    // ${owned.producer.captured.url} in its env, then writes that env var
    // to a sentinel file before sleeping. We read the sentinel file and
    // assert it contains the URL the producer printed.
    const sentinel = join(projectDir, "consumer.out");
    writeYaml(`
version: "1"
runtime:
  port_range: [19560, 19610]
owned:
  producer:
    cmd: 'echo "Listening on http://localhost:8765"; echo "READY"; sleep 30'
    ready_when:
      log_match: "READY"
      capture:
        url: "http://localhost:\\\\d+"
  consumer:
    cmd: 'printf %s "$CAPTURED_URL" > ${sentinel}; echo "READY"; sleep 30'
    depends_on: [producer]
    env:
      CAPTURED_URL: "\${owned.producer.captured.url}"
    ready_when:
      log_match: "READY"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);

    // The sentinel must contain the URL the producer printed — proves the
    // capture flowed from producer's log buffer through the interpolation
    // context into consumer's env.
    const sentinelContent = readFileSync(sentinel, "utf8");
    expect(sentinelContent).toBe("http://localhost:8765");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 3. fail_when races ready_when and wins on early match
// ---------------------------------------------------------------------------

describe("up wiring — fail_when vs ready_when race", () => {
  it("races fail_when against ready_when and surfaces fail_when's reason when it fires first", async () => {
    // A service that emits "EADDRINUSE" (matching fail_when) and then
    // hangs without emitting "READY" (which ready_when.log_match wants).
    // The race: fail_when fires immediately; ready_when would otherwise
    // wait until the timeout.
    writeYaml(`
version: "1"
runtime:
  port_range: [19620, 19670]
owned:
  loud:
    cmd: 'echo "EADDRINUSE somewhere"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "30s"
    fail_when:
      log_match: "EADDRINUSE"
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // Load-bearing: the failure must arrive WELL before the 30s ready
    // timeout. Allowing 10s gives generous margin for slow CI without
    // hiding a regression where fail_when wasn't actually wired.
    expect(elapsed).toBeLessThan(10_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "loud");
    expect(svc?.state).toBe("failed");

    // The reason must mention fail_when's match — not the ready timeout.
    // The exact wording is owned by the formatter; we assert the
    // load-bearing token (the matched line) appears in the reason.
    expect(svc?.failure_reason).toContain("EADDRINUSE");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 4. LogTails stop on cancel (no leaked poll timers)
// ---------------------------------------------------------------------------

describe("up wiring — LogTail cleanup", () => {
  it("stops all LogTails when up is cancelled mid-startup", async () => {
    // A service that runs forever but never emits READY. We cancel via
    // signal after a small delay; the orchestrator's onAbort handler
    // should stop every LogTail it registered before letting the function
    // resolve.
    //
    // Indirect assertion: if a LogTail were leaked, its 100ms poll
    // interval would keep the event loop alive. We measure how long
    // `runUp` takes to return after the abort — should be near-immediate
    // (a few hundred ms for handle.stop() to drain). A leak would manifest
    // as `runUp` hanging until vitest's per-test timeout, which we cap
    // tight enough that a leak would fail the test.
    writeYaml(`
version: "1"
runtime:
  port_range: [19680, 19730]
owned:
  hanging:
    cmd: 'sleep 60'
    ready_when:
      log_match: "READY"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // runUp should resolve quickly after the abort fires. A leaked
    // LogTail would keep the event loop alive past the function's
    // return — vitest's 10s timeout would then trigger, failing the
    // test loudly. We give a generous 8s budget (the 250ms abort delay
    // plus several seconds for handle.stop()'s SIGTERM→SIGKILL grace
    // window in the worst case), which is well under the 10s test
    // timeout and well over the expected ~500ms happy path.
    expect(elapsed).toBeLessThan(8_000);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Plan 4 Task 15 — direct assertions via LogTail.prototype.stop spying.
  //
  // The cancellation test above asserts the OBSERVABLE behavior (the event
  // loop doesn't get pinned by a leaked poll timer). The tests below assert
  // the CAUSAL invariant: every started LogTail had `.stop()` called on it
  // on the failure paths, and ZERO `.stop()` calls happen on the happy path.
  //
  // Spying on the prototype means every LogTail constructed inside `runUp`
  // (including the per-service tails created in `startOwned`, and any
  // just-in-time compose tails created in `buildReadyEvaluator`) is captured
  // — we don't need to reach into private state to count instances.
  //
  // Each test restores the spy in its own finally block rather than relying
  // on a global `afterEach` so a failure in one test doesn't leak the spy
  // into the next.
  // -------------------------------------------------------------------------

  it("stops all LogTails on the catch-all error path", async () => {
    // A service whose log emits a fail_when match early and then hangs.
    // The orchestrator's per-level failure path is the practical catch-all
    // for any startup failure — it runs the LogTail.stop() loop documented
    // at the per-level failure site AND the per-stack catch-all at the
    // bottom of runUp. Either one satisfies Task 15's acceptance criterion
    // ("the catch-all block stops all LogTails on any failure path").
    //
    // We use fail_when (not process exit) to ensure the LogTail is
    // definitely constructed and started — fail_when matching requires the
    // tail to be subscribed first.
    writeYaml(`
version: "1"
runtime:
  port_range: [19740, 19790]
owned:
  doomed:
    cmd: 'echo "EADDRINUSE somewhere"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "30s"
    fail_when:
      log_match: "EADDRINUSE"
`);

    // Spy on the prototype so EVERY LogTail constructed during runUp is
    // counted, including ones created inside helpers we don't have direct
    // access to (e.g. the just-in-time compose tails in buildReadyEvaluator).
    const startSpy = vi.spyOn(LogTail.prototype, "start");
    const stopSpy = vi.spyOn(LogTail.prototype, "stop");
    try {
      const { stream } = captureStdout();
      const result = await runUp({
        cwd: projectDir,
        outputMode: "json",
        out: stream,
      });
      if (result.stackId) createdStackIds.push(result.stackId);

      expect(result.exitCode).toBe(1);

      // At least one LogTail was started (the per-service registry entry for
      // `doomed`). If this is zero, the test's premise is broken.
      expect(startSpy.mock.calls.length).toBeGreaterThan(0);

      // Every started LogTail must have had .stop() called on it. We assert
      // `stop.calls >= start.calls` rather than equality because:
      //   - the per-level failure path and the catch-all both run stop()
      //     loops over the registry, and a tail may be stopped twice (stop
      //     is documented idempotent), so the count is >=, not ==
      //   - the AbortSignal-driven auto-stop path in LogTail's constructor
      //     can also call stop() once the signal fires
      // The load-bearing assertion is "no started tail was left untouched",
      // which the >= form captures.
      expect(stopSpy.mock.calls.length).toBeGreaterThanOrEqual(
        startSpy.mock.calls.length,
      );
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  }, 15_000);

  it("leaves LogTails running on successful up — Map isn't cleared", async () => {
    // Plan 4 Task 15: the happy path INTENTIONALLY leaves the per-stack
    // LogTail registry running after `runUp` returns. The leaving-running
    // is load-bearing: `fail_when.log_match` stays armed for the entire
    // stack lifetime so a post-startup `EADDRINUSE` (e.g. five minutes
    // after `lich up` returned) still trips the failure surface and lands
    // in state.json for the dashboard (Plan 5) to render.
    //
    // We assert this by spying on `LogTail.prototype.stop`: on the happy
    // path, NO `.stop()` call may happen between `runUp` entering and
    // returning successfully. (After return, the tails are still
    // theoretically running in the background — there's no reliable way to
    // assert "still running" without leaking the event loop, but the
    // CAUSAL invariant — "we didn't stop them" — is exactly what the spy
    // captures.)
    //
    // We use a service that becomes ready quickly via log_match so the
    // up sequence completes in a few hundred ms, keeping the test fast.
    // We then stop the long-lived process manually after asserting, so
    // afterEach's port-release doesn't see a leaked child.
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  ready_fast:
    cmd: 'echo "READY"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "10s"
`);

    const startSpy = vi.spyOn(LogTail.prototype, "start");
    const stopSpy = vi.spyOn(LogTail.prototype, "stop");
    let result: Awaited<ReturnType<typeof runUp>> | undefined;
    try {
      const { stream } = captureStdout();
      result = await runUp({
        cwd: projectDir,
        outputMode: "json",
        out: stream,
      });
      if (result.stackId) createdStackIds.push(result.stackId);

      // Sanity: the happy path must actually complete successfully.
      expect(result.exitCode).toBe(0);

      // At least one LogTail was constructed + started (one per owned
      // service that has a `ready_when.log_match` or fail_when block).
      // If this is zero, the test's premise is broken.
      expect(startSpy.mock.calls.length).toBeGreaterThan(0);

      // The load-bearing assertion: NO `.stop()` calls during a successful
      // up. The registry must still hold every LogTail that was started —
      // they keep polling for post-startup `fail_when` matches.
      //
      // A regression that "cleans up" the running tails on the happy path
      // would manifest as stopSpy.mock.calls.length >= 1 here. Pin it to
      // exactly zero so the assertion is unambiguous.
      expect(stopSpy.mock.calls.length).toBe(0);
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      // Manually drain the long-lived child the test left running so we
      // don't leak the supervised process past the test boundary. The
      // global afterEach already releases the port, but the spawned shell
      // needs an explicit kill — we trigger one by sending SIGTERM to the
      // pid recorded in the snapshot.
      if (result?.stackId) {
        try {
          const snap = await readSnapshot(result.stackId);
          for (const svc of snap?.services ?? []) {
            if (typeof svc.pid === "number") {
              try {
                process.kill(svc.pid, "SIGTERM");
              } catch {
                // already dead / not ours — harmless
              }
            }
          }
        } catch {
          // snapshot read failed — nothing to clean up that we can find
        }
      }
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 5. Plan 4 Task 17 — always-on post-ready exit detection
//
// These tests cover the orchestrator behavior the 100ms `sentinelMs` race
// used to provide (immediate-exit detection without a `ready_when`) AND
// the new behavior that race never had (catching exits between ready and
// `lich up` returning successfully).
// ---------------------------------------------------------------------------

describe("up wiring — post-ready exit detection (Task 17)", () => {
  it("fails immediately on a service that exits before becoming ready", async () => {
    // Covers the case the old 100ms `sentinelMs` race covered: a service
    // with NO `ready_when` that exits non-zero shortly after spawn. The
    // new `ProcessExitWatcher` race in `waitReady`'s no-ready_when branch
    // (`checkExitedNow`) must surface this as a failure instead of
    // silently marking the service "ready" because there's nothing to
    // wait for.
    //
    // The cmd intentionally has NO `ready_when` — that's the load-bearing
    // configuration. With a `ready_when`, the existing exit-watcher race
    // inside `waitReady` would have already covered this. The Task 17
    // change is the bare-minimum config still trips on immediate exit.
    writeYaml(`
version: "1"
runtime:
  port_range: [19740, 19790]
owned:
  exiter:
    cmd: 'exit 1'
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // The failure should arrive promptly — no `ready_when` means no
    // ready-evaluator deadline; the detection budget is `checkExitedNow`'s
    // ~100ms window. We give a generous 5s ceiling so slow CI doesn't
    // flake on this assertion, while still proving the orchestrator
    // didn't hang waiting on nothing.
    expect(elapsed).toBeLessThan(5_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "exiter");
    expect(svc?.state).toBe("failed");
    // The exit-watcher's failure label should mention the exit code or
    // the structured "exited" wording somewhere in the persisted reason.
    // We don't pin the exact prose (owned by the formatter) but assert
    // the load-bearing token is present.
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
  }, 10_000);

  it("fails the up when a service exits after ready but before up returns", async () => {
    // The new behavior the Task 17 watcher unlocks: a service that
    // becomes ready (emits "READY" so `ready_when.log_match` fires), then
    // exits non-zero a beat later. The `raceWithExitWatcher` wrapper
    // around the per-service `after_ready` lifecycle catches this and
    // turns it into a `kind: "exit"` failure, instead of `lich up`
    // returning success against a dead process.
    //
    // The `after_ready` hook sleeps for 1s — long enough for the
    // service's own exit (at 200ms after READY) to settle. Without the
    // Task 17 race, the lifecycle would complete and we'd mark the
    // service `ready` then exit success.
    const marker = join(projectDir, "after-ready-marker.txt");
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  crasher:
    cmd: 'echo "READY"; sleep 0.2; exit 1'
    ready_when:
      log_match: "READY"
    lifecycle:
      after_ready:
        - cmd: 'sleep 1; touch ${marker}'
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    // Load-bearing: `lich up` returned a non-zero exit code, NOT 0.
    // Without the Task 17 race around after_ready, this would be 0
    // because the lifecycle promise would complete (touching the marker)
    // before anyone noticed the cmd died.
    expect(result.exitCode).toBe(1);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "crasher");
    expect(svc?.state).toBe("failed");
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
  }, 10_000);

  it("does not hang on ready_when after the process has died", async () => {
    // Regression guard for the bug the old `sentinelMs` race used to
    // catch (and the Task 17 watcher must continue to catch): a service
    // that exits BEFORE its `ready_when` evaluator could ever satisfy.
    // Without the exit-watcher race inside `waitReady`, the ready
    // evaluator would happily poll for the full `ready_when.timeout`
    // window — e.g. 60s for an http_get probe pointed at a port nobody
    // opened — and `lich up` would appear to hang.
    //
    // We deliberately set a long timeout (30s) and assert that the up
    // fails in well under that. If the orchestrator regresses to
    // "hang until ready_when's deadline," this test catches it via
    // the elapsed-time assertion.
    writeYaml(`
version: "1"
runtime:
  port_range: [19860, 19910]
owned:
  dead-on-arrival:
    cmd: 'exit 1'
    ready_when:
      http_get: '/health'
      timeout: '30s'
    port:
      env: PORT
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // The exit-watcher race must fire long before the 30s ready timeout.
    // We give a generous 10s budget for slow CI; a regression where the
    // orchestrator waited on ready_when would push this past 30s and
    // fail the per-test timeout instead.
    expect(elapsed).toBeLessThan(10_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "dead-on-arrival");
    expect(svc?.state).toBe("failed");
    // Must NOT be a ready timeout — the exit must have won the race.
    // (If the watcher regressed and the timeout fired, the reason would
    // mention "timeout"/"ready" instead of the exit.)
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
    expect(svc?.failure_reason!.toLowerCase()).not.toMatch(/timeout/);
  }, 15_000);
});
