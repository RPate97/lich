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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
