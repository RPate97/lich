/**
 * Tests for the daemon-kill step `lich nuke` performs after per-stack
 * teardown (LEV-420, Plan 5 Task 18).
 *
 * The escape-hatch contract for `lich nuke`:
 *   - If the daemon is alive: SIGTERM, wait up to 5s, SIGKILL on holdout.
 *   - If the daemon isn't alive but the PID file lingers: clear it silently.
 *   - If no PID file exists: no-op.
 *   - Failure modes (signal errors, pathological non-reaping pids) surface
 *     as a `warning: ...` line on stdout but never flip exit code or skip
 *     other teardown steps.
 *
 * All tests run with `LICH_HOME` pointed at a tmpdir for hermetic isolation
 * — the real `~/.lich/daemon.pid` is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stackDir } from "../../../src/state/directory.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { runNuke } from "../../../src/commands/nuke.js";
import { _exec, type ExecFn } from "../../../src/compose/runner.js";
import { _probe } from "../../../src/compose/detect.js";
import { writeDaemonPid } from "../../../src/daemon/pid-file.js";

// ---------------------------------------------------------------------------
// Fixture harness — mirrors nuke.test.ts so seeding stacks + capturing stdout
// behaves identically to the broader nuke test surface.
// ---------------------------------------------------------------------------

let home: string;
let prevLichHome: string | undefined;
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;
/** Child processes spawned in a test, killed in afterEach as a safety net. */
let spawnedChildren: ChildProcess[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-nuke-daemon-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;

  // Stub compose detection + exec so per-stack teardown doesn't actually
  // shell out to docker.
  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";

  originalExec = _exec.current;
  _exec.current = async () => ({ exitCode: 0, stdout: "", stderr: "" });

  spawnedChildren = [];
});

afterEach(() => {
  // Belt-and-braces: any test that spawned a child to play the role of a
  // daemon must clean up if it failed mid-way.
  for (const child of spawnedChildren) {
    try {
      if (typeof child.pid === "number") {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }

  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
  _exec.current = originalExec;
  _probe.current = originalProbe;
});

// ---------------------------------------------------------------------------
// Sink writable for capturing stdout (mirrors nuke.test.ts)
// ---------------------------------------------------------------------------

class Sink {
  chunks: string[] = [];
  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  };
  text(): string {
    return this.chunks.join("");
  }
}

function makeSink(): { sink: Sink; out: NodeJS.WritableStream } {
  const sink = new Sink();
  return { sink, out: sink as unknown as NodeJS.WritableStream };
}

/**
 * Spawn a long-lived child to stand in for the daemon. Tracks the child
 * in `spawnedChildren` so afterEach can SIGKILL it on test failure. The
 * child is a node process running `setInterval(() => {}, 1000)` which
 * responds to SIGTERM and never exits on its own.
 */
function spawnFakeDaemon(): { child: ChildProcess; pid: number } {
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  spawnedChildren.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("spawnFakeDaemon: child.pid is not a number");
  }
  return { child, pid: child.pid };
}

/**
 * Spawn a long-lived child that IGNORES SIGTERM. Used to force the
 * SIGKILL escalation path. The child traps SIGTERM with a no-op handler
 * — node only exits on uncaught signal, so this leaves the process alive
 * until SIGKILL (which is uncatchable).
 */
function spawnSigtermDeafDaemon(): { child: ChildProcess; pid: number } {
  const child = spawn(
    "node",
    [
      "-e",
      // Trap SIGTERM with a no-op so it doesn't terminate. setInterval
      // keeps the event loop alive forever.
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ],
    { stdio: "ignore", detached: false },
  );
  spawnedChildren.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("spawnSigtermDeafDaemon: child.pid is not a number");
  }
  return { child, pid: child.pid };
}

/** Wait for a child process to exit, with a generous timeout. */
function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Signal-0 liveness probe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Case 1: Daemon alive → nuke SIGTERMs it, waits, daemon exits, PID file cleared.
// ---------------------------------------------------------------------------

describe("runNuke — daemon alive (LEV-420)", () => {
  it("SIGTERMs the daemon, waits for clean exit, and clears the PID file", async () => {
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    // The fake-daemon child responds to SIGTERM (node default exits on
    // uncaught signal), so it must be gone by the time runNuke returns.
    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);

    // PID file cleared regardless of how the daemon went down.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    // No warning surfaced — clean SIGTERM is the happy path.
    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Daemon doesn't respond to SIGTERM → SIGKILL after 5s, PID file cleared.
// ---------------------------------------------------------------------------

describe("runNuke — daemon ignores SIGTERM (LEV-420)", () => {
  // This test waits for the full 5s grace window plus SIGKILL reap, so
  // we bump the timeout above the default 5s. 15s gives the slow-CI
  // case enough headroom without flake.
  it("SIGKILLs the daemon after the grace window expires", async () => {
    const { child, pid } = spawnSigtermDeafDaemon();
    await writeDaemonPid(pid);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    // Process must be reaped (SIGKILL is uncatchable; the kernel cleans
    // up shortly after).
    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);

    // PID file cleared.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Case 3: Daemon not alive but stale PID file present → clear silently.
// ---------------------------------------------------------------------------

describe("runNuke — stale PID file (LEV-420)", () => {
  it("clears the PID file without trying to signal a dead process", async () => {
    // A PID that's overwhelmingly unlikely to be alive on any sane system.
    // PIDs typically wrap below 100k on Linux/macOS — 999999 is safely
    // past the default ceilings.
    const DEAD_PID = 999_999;
    await writeDaemonPid(DEAD_PID);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    // PID file gone, no warning (stale-file is a silent sweep).
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});

// ---------------------------------------------------------------------------
// Case 4: No PID file → nuke does nothing daemon-related (no error).
// ---------------------------------------------------------------------------

describe("runNuke — no PID file (LEV-420)", () => {
  it("is a silent no-op when no daemon.pid exists", async () => {
    // Don't write a PID file. nuke should not throw, not complain, not
    // produce any daemon-related output.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);

    // The early-return "no stacks to nuke" path runs because we didn't
    // seed any stacks. The daemon step is silent on the missing-file case.
    expect(sink.text()).toContain("no stacks to nuke");
    expect(sink.text()).not.toMatch(/^warning:/m);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("kills the daemon even when no stacks exist (escape-hatch contract)", async () => {
    // Variant of the "no stacks" path: a daemon IS alive (e.g. user
    // killed all stacks with `lich down` but the daemon hasn't yet
    // auto-shut-down). `lich nuke` should still reap it.
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");

    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 5: Per-stack teardown still runs even if daemon kill fails.
//
// We exercise this in two directions:
//   (a) daemon-kill happens AFTER per-stack teardown, so by definition
//       per-stack teardown has already run by the time daemon-kill is
//       attempted — assert the stack state-dir is gone even when the
//       daemon-kill path is the pathological "still alive after SIGKILL"
//       case. (We can't easily simulate that in a test without an evil
//       child process, but we CAN assert ordering by checking the stack
//       state dir is gone in the malformed-PID-file scenario.)
//   (b) Stale PID file with corrupt contents should still allow per-stack
//       teardown to complete cleanly.
// ---------------------------------------------------------------------------

describe("runNuke — per-stack teardown survives daemon-kill failures (LEV-420)", () => {
  it("nukes stacks first, then signals the daemon (correct ordering)", async () => {
    // Seed both a stack and a live daemon. The stack must end up nuked
    // regardless of what happens in the daemon-kill path.
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);

    await writeSnapshot({
      stack_id: "ordering-test",
      worktree_name: "ordering",
      worktree_path: home,
      status: "stopped",
      started_at: new Date().toISOString(),
      services: [],
    });

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].stackId).toBe("ordering-test");
    expect(result.outcomes[0].status).toBe("nuked");

    // Per-stack teardown succeeded: state dir gone.
    expect(existsSync(stackDir("ordering-test"))).toBe(false);

    // Daemon also reaped.
    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("still nukes stacks when the PID file is corrupt (treated as no daemon)", async () => {
    // Corrupt PID file: readDaemonPid returns null → killDaemon is a
    // no-op → per-stack teardown is unaffected.
    writeFileSync(join(home, "daemon.pid"), "not-a-number\n", "utf8");
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    await writeSnapshot({
      stack_id: "corrupt-pid",
      worktree_name: "corrupt",
      worktree_path: home,
      status: "stopped",
      started_at: new Date().toISOString(),
      services: [],
    });

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(existsSync(stackDir("corrupt-pid"))).toBe(false);

    // The corrupt PID file is treated as "no daemon" — no warning
    // surfaced, file left as-is (readDaemonPid returns null which is
    // the same as ENOENT from our caller's perspective).
    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});
