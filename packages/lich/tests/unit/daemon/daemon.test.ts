/**
 * Unit tests for the daemon main entry — LEV-406, Plan 5 Task 4.
 *
 * Coverage:
 *   - PID file is written with process.pid on startup
 *   - signal.abort() triggers clean shutdown (PID file cleared, watcher stopped)
 *   - Auto-shutdown fires after N empty ticks when no stacks are present
 *   - Auto-shutdown does NOT fire when a stack with status="up" exists
 *   - Dashboard + proxy stub log lines are emitted on startup
 *   - Concurrent abort calls don't double-cleanup (idempotent)
 *   - Refuses to start when another daemon is already alive
 *   - Stale PID file (dead PID) is overwritten on startup
 *
 * Tests use a tmpdir for LICH_HOME and a tiny `shutdownCheckMs` (e.g. 20ms)
 * with `shutdownGraceTicks: 1` so the auto-shutdown path completes in
 * test-friendly time without actually waiting the production 30s grace.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runDaemon } from "../../../src/daemon/daemon.js";
import {
  readDaemonPid,
  writeDaemonPid,
} from "../../../src/daemon/pid-file.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test gets a fresh tmpdir to use as LICH_HOME. We do NOT mutate
// process.env.LICH_HOME at the harness level — the daemon mutates it
// internally for the duration of its run and restores on shutdown, so
// each test passes its own `opts.lichHome` and we leave the env alone.
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-daemon-main-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * PID that's overwhelmingly unlikely to be alive on any system. Mirrors
 * the constant from pid-file.test.ts. Used to construct a stale PID
 * file the daemon must overwrite on startup.
 */
const DEAD_PID = 999_999;

/**
 * Capture the daemon's log output into a buffer we can assert against.
 * The PassThrough stream lets the daemon write synchronously while the
 * `chunks` array accumulates everything for later inspection.
 */
function captureLog(): {
  stream: PassThrough;
  output: () => string;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Helper: write a state.json with the given status under
 * `<home>/stacks/<stackId>/`. Used to put a "live" stack in place
 * before starting the daemon so the auto-shutdown path sees it as
 * still alive and doesn't fire.
 */
function writeFakeStack(stackId: string, status: string): void {
  const stackDir = join(home, "stacks", stackId);
  mkdirSync(stackDir, { recursive: true });
  const snapshot = {
    stack_id: stackId,
    worktree_name: "test",
    worktree_path: "/tmp/test",
    status,
    started_at: new Date().toISOString(),
    services: [],
  };
  writeFileSync(
    join(stackDir, "state.json"),
    JSON.stringify(snapshot) + "\n",
    "utf8",
  );
}

/**
 * Drive a daemon run with a generous wall-clock budget. Returns the
 * abort controller so the test can shut down the daemon, plus a
 * promise that resolves with the daemon's exit code.
 *
 * `shutdownCheckMs: 20` + `shutdownGraceTicks: 1` makes auto-shutdown
 * fire after a single ~20ms tick — far below the production ~30s
 * grace, but long enough that a deliberate "stack appears mid-run"
 * test can still race a fake stack into place.
 */
function startDaemon(opts: {
  signal?: AbortSignal;
  out?: NodeJS.WritableStream;
  shutdownCheckMs?: number;
  shutdownGraceTicks?: number;
}): Promise<{ exitCode: number }> {
  return runDaemon({
    lichHome: home,
    proxyPort: 3300,
    signal: opts.signal,
    out: opts.out,
    shutdownCheckMs: opts.shutdownCheckMs ?? 20,
    shutdownGraceTicks: opts.shutdownGraceTicks ?? 1,
  });
}

// ---------------------------------------------------------------------------
// 1. PID file written with process.pid on startup
// ---------------------------------------------------------------------------

describe("runDaemon — PID file lifecycle", () => {
  it("writes the PID file with process.pid on startup", async () => {
    // Pre-populate a fake "up" stack so the daemon doesn't auto-shut
    // before we can read the PID file. Then abort via the controller
    // once we've verified the file is present.
    writeFakeStack("test-stack-1", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000, // long — we abort manually
      shutdownGraceTicks: 3,
    });

    // Poll the PID file: the daemon's startup is asynchronous (writes
    // happen inside runDaemon's first await), so we wait briefly.
    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    expect(pid).toBe(process.pid);

    // Cleanup — abort the daemon so the test doesn't hang.
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("clears the PID file on clean shutdown via signal.abort", async () => {
    writeFakeStack("test-stack-2", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup to complete (PID file present).
    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    // Abort and wait for shutdown to finish.
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);

    // PID file must be gone after clean shutdown.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(await readDaemonPid({ lichHome: home })).toBeNull();
  });

  it("overwrites a stale PID file (dead PID) on startup", async () => {
    // Pre-write a PID file pointing at a definitely-dead process.
    // Without stale-detect logic the daemon would refuse to start.
    await writeDaemonPid(DEAD_PID, { lichHome: home });
    expect(await readDaemonPid({ lichHome: home })).toBe(DEAD_PID);

    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
    });

    // After startup, the PID file should reflect OUR pid, not the stale
    // one. Poll for it.
    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null && pid !== DEAD_PID) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(pid).toBe(process.pid);

    controller.abort();
    await daemonPromise;
  });

  it("refuses to start when another daemon is already alive (PID = current process)", async () => {
    // Write a PID file with the CURRENT process's pid — that's
    // guaranteed to be alive (we're running this test code). The
    // daemon should detect this and bail out with exit 1.
    await writeDaemonPid(process.pid, { lichHome: home });

    const { stream } = captureLog();
    const result = await runDaemon({
      lichHome: home,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(1);
    // PID file should still point at us (we didn't overwrite it on
    // refuse-to-start — that would break the rightful owner's
    // lifecycle).
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// 2. Signal abort triggers clean shutdown
// ---------------------------------------------------------------------------

describe("runDaemon — signal abort", () => {
  it("shuts down cleanly when signal is aborted", async () => {
    writeFakeStack("test-stack-3", "up");
    const controller = new AbortController();
    const { stream, output } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // Fire abort. The daemon should resolve quickly (well under 1s).
    const abortStart = Date.now();
    controller.abort();
    const result = await daemonPromise;
    const elapsed = Date.now() - abortStart;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(1_000);
    // The "shutdown requested" log line carries our reason.
    expect(output()).toContain("shutdown requested");
  });

  it("handles an already-aborted signal at startup (immediate shutdown)", async () => {
    // Pre-abort the controller before runDaemon even starts. The daemon
    // should detect this and exit cleanly without waiting for ticks.
    const controller = new AbortController();
    controller.abort();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Must resolve fast — < 1s wall clock.
    const start = Date.now();
    const result = await daemonPromise;
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    // PID file cleaned up.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-shutdown when no stacks present
// ---------------------------------------------------------------------------

describe("runDaemon — auto-shutdown", () => {
  it("auto-shuts down when no alive stacks exist", async () => {
    // No state.json files anywhere. With shutdownCheckMs=20 and
    // shutdownGraceTicks=1, the daemon's first tick (after a 20ms
    // delay) should see zero alive stacks and trigger shutdown.
    const { stream, output } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toContain("auto-shutdown");
    // PID file cleared post-shutdown.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("does NOT auto-shutdown when a stack with status=up exists", async () => {
    writeFakeStack("alive-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    // Let the auto-shutdown tick fire a few times. With graceTicks=1
    // and an alive stack, the empty-tick counter should never increment.
    await new Promise<void>((r) => setTimeout(r, 200));

    // The daemon should STILL be running. Verify by checking the PID
    // file is still present (it would be cleared on shutdown).
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);

    // Cleanup
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("does NOT auto-shutdown when a stack with status=starting exists", async () => {
    // "starting" is in the ALIVE_STATUSES set per the spec — a stack
    // mid-startup should keep the daemon alive.
    writeFakeStack("starting-stack", "starting");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    controller.abort();
    await daemonPromise;
  });

  it("DOES auto-shutdown when only stopped/failed stacks exist", async () => {
    // Stopped and failed stacks are history — they shouldn't keep
    // the daemon alive. With graceTicks=1, the first tick after the
    // initial 20ms delay should fire shutdown.
    writeFakeStack("done-stack", "stopped");
    writeFakeStack("broken-stack", "failed");
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("requires N consecutive empty ticks before shutting down", async () => {
    // With graceTicks=3 the daemon must see 3 empty ticks in a row.
    // We poll the log output to confirm multiple ticks fire before
    // the auto-shutdown actually triggers.
    const { stream, output } = captureLog();

    const start = Date.now();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 30,
      shutdownGraceTicks: 3,
    });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // 3 ticks at 30ms each = ~90ms minimum, plus the initial delay
    // and the first tick's grace. Allow a generous lower bound.
    expect(elapsed).toBeGreaterThan(75);
    expect(output()).toContain("3 empty ticks");
  });
});

// ---------------------------------------------------------------------------
// 4. Dashboard + proxy stub logging
// ---------------------------------------------------------------------------

describe("runDaemon — stub logging", () => {
  it("logs the dashboard and proxy stub strings on startup", async () => {
    // The "real" dashboard + proxy land in Tasks 6 and 11. For Task 4
    // we just emit log lines so tests can assert the wiring exists.
    const { stream, output } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    const captured = output();
    expect(captured).toContain("dashboard would start here");
    expect(captured).toContain("proxy would start here");
  });

  it("threads the configured proxyPort into the proxy stub log line", async () => {
    const { stream, output } = captureLog();

    const result = await runDaemon({
      lichHome: home,
      proxyPort: 4567,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toContain("proxy would start here on port 4567");
  });

  it("defaults the proxy port to 3300 when not specified", async () => {
    const { stream, output } = captureLog();

    const result = await runDaemon({
      lichHome: home,
      // proxyPort omitted on purpose
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toContain("proxy would start here on port 3300");
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent abort doesn't double-cleanup
// ---------------------------------------------------------------------------

describe("runDaemon — concurrent abort safety", () => {
  it("survives multiple rapid signal.abort() calls without erroring", async () => {
    writeFakeStack("test-stack-4", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // Fire the abort signal multiple times in rapid succession. Each
    // `abort()` call dispatches the 'abort' event again on AbortSignal,
    // but our handler is idempotent so this should be safe.
    controller.abort();
    controller.abort();
    controller.abort();

    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("running runDaemon twice sequentially leaves a clean state each time", async () => {
    // First run.
    const c1 = new AbortController();
    const { stream: s1 } = captureLog();
    const d1 = startDaemon({
      signal: c1.signal,
      out: s1,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline1 = Date.now() + 2_000;
    while (Date.now() < deadline1) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    c1.abort();
    const r1 = await d1;
    expect(r1.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    // Second run — must succeed since the first cleared the PID file.
    const c2 = new AbortController();
    const { stream: s2 } = captureLog();
    const d2 = startDaemon({
      signal: c2.signal,
      out: s2,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline2 = Date.now() + 2_000;
    while (Date.now() < deadline2) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
    c2.abort();
    const r2 = await d2;
    expect(r2.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. LICH_HOME plumbing — env restoration on shutdown
// ---------------------------------------------------------------------------

describe("runDaemon — LICH_HOME env handling", () => {
  it("restores process.env.LICH_HOME on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    const sentinel = "/should-be-restored";
    process.env.LICH_HOME = sentinel;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      // Wait for startup — at which point env.LICH_HOME has been
      // mutated to `home`. Verify the mutation happened.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      // Shut down, then verify the env was restored.
      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBe(sentinel);
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });

  it("restores an UNSET LICH_HOME (delete) on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    delete process.env.LICH_HOME;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBeUndefined();
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Stack snapshot reading — robustness
// ---------------------------------------------------------------------------

describe("runDaemon — state directory robustness", () => {
  it("treats unreadable/malformed state.json as not-alive (does not crash)", async () => {
    // Put a malformed JSON file where state.json should be. The
    // daemon's count-alive-stacks should treat it as not alive and
    // proceed to auto-shutdown.
    const stackDir = join(home, "stacks", "broken-stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "state.json"), "{ not valid json", "utf8");

    const { stream } = captureLog();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // Original file should still be there — we didn't touch it.
    expect(
      readFileSync(join(stackDir, "state.json"), "utf8").includes("not valid"),
    ).toBe(true);
  });

  it("handles an empty stacks directory by auto-shutting down", async () => {
    // Pre-create the stacks dir but leave it empty.
    mkdirSync(join(home, "stacks"), { recursive: true });
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
  });

  it("tolerates a missing stacks directory entirely", async () => {
    // home exists; <home>/stacks does NOT. The watcher should create
    // the directory, the auto-shutdown count should return 0, and
    // the daemon should exit cleanly.
    expect(existsSync(join(home, "stacks"))).toBe(false);
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // The watcher's start() creates the stacks dir as a side effect.
    expect(existsSync(join(home, "stacks"))).toBe(true);
  });
});
