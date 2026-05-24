/**
 * Unit tests for SIGINT propagation — LEV-302.
 *
 * Two flavors of coverage:
 *
 *   1. `runUp` accepts an `AbortSignal` and, when aborted mid-startup,
 *      tears down everything it started within a small wall-clock budget
 *      (no waiting for ready_when to time out, no leaked PIDs, ports
 *      released, state.json marked failed). This is the contract layer —
 *      same surface area as the bin-layer SIGINT handler uses.
 *
 *   2. Spawn the compiled `dist/lich` binary against a stack that never
 *      becomes ready, send a real SIGINT, and assert the binary exits
 *      cleanly within ~2s with state.json in a failed/cancelled state.
 *      This is the "actually works end-to-end" check the testing standards
 *      doc requires alongside any contract-level test.
 *
 * Why both:
 *   - The contract test runs in <2s, no subprocess, and catches regressions
 *     in the orchestrator's cancellation wiring (the ready evaluators
 *     honoring the signal, runOneshot rethrowing as "aborted", the abort
 *     handler cleaning up state/ports/handles).
 *   - The binary test catches the wiring that ONLY exists at the
 *     process-spawn boundary: the `process.on('SIGINT')` handler in
 *     bin/lich.ts, the AbortController plumbing, the exit-code conventions.
 *     The contract test can pass while the bin layer is broken — which is
 *     exactly the situation LEV-302 documented.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import {
  readSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { listAllocations, release } from "../../../src/ports/allocator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const packageRoot = resolve(__dirname, "../../..");
const lichBinary = resolve(packageRoot, "dist/lich");

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let childToReap: ChildProcess | null = null;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-sigint-home-"));
  // `stack-` prefix matches the helper convention in commands/up.test.ts so
  // the worktree detection finds a clean root.
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  childToReap = null;
});

afterEach(async () => {
  // Best-effort: SIGKILL any spawned binary that escaped the test (e.g.
  // assertion failed before the SIGINT could be sent). Without this a flaky
  // test leaks a lich subprocess that holds onto ports.
  if (childToReap && childToReap.pid && !childToReap.killed) {
    try {
      process.kill(childToReap.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  childToReap = null;

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

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

async function loadSnapshot(stackId: string): Promise<StackSnapshot | null> {
  return readSnapshot(stackId);
}

// ---------------------------------------------------------------------------
// Tests — runUp contract (no subprocess)
// ---------------------------------------------------------------------------

describe("runUp — SIGINT/AbortSignal cancellation contract", () => {
  it("aborts the in-flight tcp ready wait and marks the stack failed within 2s", async () => {
    // tcp probe at localhost:1 — nothing listens there, the polling loop
    // would run forever without the signal cancelling it.
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19550]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    // Fire the abort a hair after up starts polling. 150ms is enough lead
    // time for the supervisor to have spawned the child and started the
    // tcp poll loop.
    setTimeout(() => controller.abort(), 150);

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    // The whole runUp call (including cleanup) must complete well under
    // the 2s "cancellation feels responsive" budget. 1500ms gives margin
    // for slow CI without masking a real regression.
    expect(elapsedMs).toBeLessThan(1500);
    expect(result.exitCode).toBe(1);

    const snap = await loadSnapshot(result.stackId!);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("failed");
  }, 10_000);

  it("releases allocated ports when cancelled mid-startup", async () => {
    // Multi-port owned that hangs on ready_when. After the abort the
    // allocator registry must show NO entry for our stack — otherwise a
    // follow-up `lich up` would race a stale reservation.
    writeYaml(`
version: "1"
runtime:
  port_range: [19600, 19650]
owned:
  stuck:
    cmd: "sleep 60"
    port: { env: PORT }
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // The cancellation handler releases ports. listAllocations is the
    // canonical view onto the registry; our stack id should be gone (or
    // never have been there if the test got cancelled before allocation
    // finished — both outcomes are fine for the contract).
    const allocations = await listAllocations();
    expect(allocations[result.stackId!]).toBeUndefined();
  }, 10_000);

  it("kills the owned child process so it doesn't outlive the lich call", async () => {
    // Spawn a child that ignores SIGTERM. Without our cancellation
    // wiring's stop() escalation (SIGTERM → SIGKILL), the child would
    // survive runUp's return and orphan itself. We verify it's gone.
    writeYaml(`
version: "1"
runtime:
  port_range: [19700, 19750]
owned:
  stuck:
    cmd: "trap '' TERM; echo READY-SENTINEL; sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // We can't fish the PID out of runUp's return shape, but we can
    // inspect state.json: the supervisor records the PID when it spawns.
    // After cancellation the child must be dead — verified by
    // `process.kill(pid, 0)` which throws ESRCH for missing processes.
    //
    // Brief wait so SIGKILL has a chance to be delivered + reaped.
    await new Promise((r) => setTimeout(r, 300));

    const snap = await loadSnapshot(result.stackId!);
    expect(snap).not.toBeNull();
    const stuckSnap = snap!.services.find((s) => s.name === "stuck");
    if (stuckSnap?.pid !== undefined) {
      let alive = false;
      try {
        process.kill(stuckSnap.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 10_000);

  it("treats a pre-aborted signal as immediate cancellation", async () => {
    // If the caller passes a signal that's ALREADY aborted, runUp must
    // not start spawning children — the user's intent is "do nothing, get
    // out." This covers the race where SIGINT lands between `lich up`
    // parsing argv and the handler's first await.
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    controller.abort();

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    // Pre-aborted should resolve very quickly — no waiting on polls.
    expect(elapsedMs).toBeLessThan(1000);
    expect(result.exitCode).toBe(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Tests — compiled binary actually handles SIGINT
// ---------------------------------------------------------------------------

describe("lich binary — SIGINT handler integration", () => {
  // NOTE: Bun's test runner doesn't accept a timeout as beforeAll's 2nd arg
  // (vitest does). If you need a longer timeout, move the work into an it().
  beforeAll(() => {
    // Build the binary if it isn't present. We don't unconditionally rebuild
    // — that adds 1-2s per test run; the dist artifact is the same shape as
    // what e2e tests assume.
    if (!existsSync(lichBinary)) {
      const build = spawnSync("bun", ["run", "build"], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      if (build.status !== 0) {
        throw new Error(
          `failed to build lich binary: ${build.stderr || build.stdout}`,
        );
      }
    }
    // Sanity check.
    if (!existsSync(lichBinary)) {
      throw new Error(`lich binary still missing at ${lichBinary}`);
    }
  });

  it("exits within 2s of SIGINT when waiting on an unreachable tcp probe", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19900, 19950]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const proc = spawn(lichBinary, ["up", "--json"], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childToReap = proc;

    let stdoutBuf = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {
      /* drain */
    });

    // Wait for json output to confirm the binary actually started its work
    // (parsed yaml, allocated ports, spawned the owned). Without this gate
    // the SIGINT can land before the orchestrator even has the chance to
    // install its own signal listener — which would look like a pass but
    // is actually a race. We watch for a `phase_begin` with a `start `
    // prefix — that's emitted just before the owned spawn (LEV-301
    // renamed the phase from `start-level-N` to `start N/total (svc)`).
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline) {
      if (stdoutBuf.includes('"name":"start ')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stdoutBuf).toContain('"name":"start ');

    // Snapshot the time, send SIGINT, await exit.
    const startedAt = Date.now();
    proc.kill("SIGINT");

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
    });
    const elapsedMs = Date.now() - startedAt;
    childToReap = null;

    // The binary must wind down well under 2s after the SIGINT lands. We
    // give a bit of margin (1800ms) so CI doesn't flake on slow machines
    // but the budget still proves the handler is working.
    expect(elapsedMs).toBeLessThan(1800);
    // Conventional SIGINT exit code is 130 (= 128 + 2). The bin layer
    // chooses 130 when the controller was aborted; that's the surface
    // tests should assert on.
    expect(exitCode).toBe(130);

    // state.json should reflect status:failed (we don't add a
    // `cancelled` status to keep state/ untouched per scope).
    const stacks = (await import("node:fs/promises")).readdir(
      join(homeDir, "stacks"),
    );
    const stackIds = await stacks;
    expect(stackIds.length).toBeGreaterThan(0);
    const stackId = stackIds[0]!;
    createdStackIds.push(stackId);

    const snap = await loadSnapshot(stackId);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("failed");
  }, 30_000);

  it("force-exits with 130 on a second SIGINT", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [20000, 20050]
owned:
  stuck:
    cmd: "trap '' TERM; sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const proc = spawn(lichBinary, ["up", "--json"], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childToReap = proc;

    let stdoutBuf = "";
    let stderrBuf = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
    });

    // Wait for the orchestrator to have spawned the owned child so the
    // first SIGINT has actual work to cancel.
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline) {
      if (stdoutBuf.includes("start-level-")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Two SIGINTs in quick succession — the second one should force-exit
    // BEFORE the SIGTERM-grace cleanup window expires (5s). The trap-
    // ignoring child means without the second SIGINT, the binary would
    // wait the full grace before SIGKILLing and unwinding — comfortably
    // more than 3s. If the binary exits inside 2s, the only way that's
    // possible is the second-SIGINT handler firing process.exit(130).
    //
    // Attach the exit listener BEFORE sending any signal so we never lose
    // an early exit event to a missed listener.
    let exitCode: number | null = null;
    let exited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve(code);
      });
    });

    // Wait until the binary's first-SIGINT handler has acknowledged the
    // signal (it prints "cancelling…" to stderr); only then is the
    // process armed for the second SIGINT to be the "force quit." Sending
    // the second too early can race the bin layer's signal-handler
    // installation if the first SIGINT arrived before the orchestrator's
    // first await yielded.
    proc.kill("SIGINT");
    const ackDeadline = Date.now() + 3_000;
    while (Date.now() < ackDeadline) {
      if (stderrBuf.includes("cancelling") || exited) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stderrBuf).toContain("cancelling");

    // If the process already exited from the first SIGINT (the cleanup
    // path completed faster than the SIGTERM grace), there's no second
    // SIGINT to test — that's a legitimate code path but doesn't exercise
    // the force-quit logic. Skip the rest in that case rather than
    // reporting a spurious failure; the first-SIGINT test already proves
    // graceful cancellation works.
    if (exited) {
      expect(exitCode).toBe(130);
      childToReap = null;
      return;
    }

    const startedAt = Date.now();
    proc.kill("SIGINT");

    await exitPromise;
    const elapsedMs = Date.now() - startedAt;
    childToReap = null;

    // 2s window is generous enough to absorb CI scheduling variability
    // while still being clearly less than the 5s SIGTERM grace the
    // cleanup path would otherwise wait. If the second-SIGINT handler
    // weren't wired, elapsed would land near 5s.
    expect(elapsedMs).toBeLessThan(2000);
    expect(exitCode).toBe(130);

    // Best-effort cleanup of the stack dir for the afterEach.
    const stacksDir = join(homeDir, "stacks");
    if (existsSync(stacksDir)) {
      const ids = (await import("node:fs")).readdirSync(stacksDir);
      for (const id of ids) createdStackIds.push(id);
    }
  }, 30_000);
});

