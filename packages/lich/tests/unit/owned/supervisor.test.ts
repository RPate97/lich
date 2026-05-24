/**
 * Unit tests for the owned-service supervisor.
 *
 * Each test:
 *   - sets `LICH_HOME` to a fresh tmpdir so log files don't escape the test
 *   - uses `ensureStackDir` + `serviceLogPath` to source the log path (proves
 *     the supervisor integrates with the real state-directory layout)
 *   - runs a tiny shell command (<100ms) so the suite stays fast
 *   - reads the log file after exit to assert on captured output
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureStackDir,
  serviceLogPath,
} from "../../../src/state/directory.js";
import { startOwnedService } from "../../../src/owned/supervisor.js";

const STACK_ID = "test-stack";

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "lich-owned-test-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  await ensureStackDir(STACK_ID);
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  await rm(homeDir, { recursive: true, force: true });
});

/**
 * Read a service's log file. Brief retry to absorb the lag between the
 * child's exit and the WriteStream's `end()` flush — the supervisor
 * `end()`s the stream synchronously on exit, but on some platforms the
 * file-system fsync lags a tick or two.
 */
async function readLog(name: string): Promise<string> {
  const path = serviceLogPath(STACK_ID, name);
  for (let i = 0; i < 20; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return await readFile(path, "utf8");
}

describe("startOwnedService — happy path", () => {
  it("spawns a process, runs it to completion, and captures stdout to the log file", async () => {
    const name = "echo-svc";
    const handle = await startOwnedService({
      name,
      cmd: "echo hello && sleep 0.05",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.name).toBe(name);

    const result = await handle.exited;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    const log = await readLog(name);
    expect(log).toContain("hello");
  });

  it("injects env vars from spec.env into the spawned process", async () => {
    const name = "env-svc";
    const handle = await startOwnedService({
      name,
      cmd: "echo $MY_VAR",
      cwd: homeDir,
      env: { MY_VAR: "set-via-env" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    expect(log).toContain("set-via-env");
  });

  it("injects the allocated port under portEnvVar", async () => {
    const name = "port-svc";
    const handle = await startOwnedService({
      name,
      cmd: "echo got=$PORT",
      cwd: homeDir,
      env: {},
      portEnvVar: "PORT",
      port: 7777,
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    expect(log).toContain("got=7777");
  });

  it("captures stderr into the same log file as stdout", async () => {
    const name = "stderr-svc";
    const handle = await startOwnedService({
      name,
      cmd: "echo to-stderr 1>&2",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    expect(log).toContain("to-stderr");
  });
});

describe("startOwnedService — stop()", () => {
  /**
   * Wait for the child shell to print "READY" before signaling. Without this,
   * `stop()` can race the shell's `trap` builtin: SIGTERM arriving before
   * `trap` has been parsed kills the process with the default handler,
   * bypassing the trap entirely. The script prints "READY" right after
   * installing its handlers, so we know `kill -TERM` will hit the trap.
   */
  async function waitForReady(name: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const log = await readFile(serviceLogPath(STACK_ID, name), "utf8");
        if (log.includes("READY")) return;
      } catch {
        /* log file not yet created */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`service ${name} never printed READY within ${timeoutMs}ms`);
  }

  it("stops a long-running process gracefully via SIGTERM", async () => {
    const name = "graceful-svc";
    const handle = await startOwnedService({
      name,
      cmd: "trap 'echo bye; exit 0' TERM; echo READY; while true; do sleep 0.1; done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    expect(handle.pid).toBeGreaterThan(0);
    await waitForReady(name);

    await handle.stop();
    const result = await handle.exited;
    expect(result.code).toBe(0);

    const log = await readLog(name);
    expect(log).toContain("bye");
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const name = "stubborn-svc";
    const handle = await startOwnedService({
      name,
      // Trap and ignore SIGTERM; the only way out is SIGKILL.
      cmd: "trap '' TERM; echo READY; while true; do sleep 0.1; done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    await waitForReady(name);
    await handle.stop(200);
    const result = await handle.exited;
    expect(result.signal).toBe("SIGKILL");
  });

  it("stops a SIGTERM-ignoring process via SIGKILL escalation and verifies dead afterward (LEV-312)", async () => {
    // The full LEV-312 contract: SIGTERM is trapped + ignored, escalation
    // fires SIGKILL, and after stop() resolves the pid MUST be reaped.
    // Verifies the post-SIGKILL liveness check returns the right answer
    // for the common path — no warning, process actually gone.
    const name = "verify-dead-svc";
    const handle = await startOwnedService({
      name,
      cmd: "trap '' TERM; echo READY; while true; do sleep 0.1; done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    await waitForReady(name);
    const recordedPid = handle.pid;

    await handle.stop(200);
    // No warning on the happy-path "SIGKILL did its job" case.
    expect(handle.stopWarning).toBeNull();

    // The pid must NOT answer signal 0 — kernel reaped it.
    let alive = true;
    try {
      process.kill(recordedPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    // Belt-and-braces: the exited promise also resolved with SIGKILL.
    const exitInfo = await handle.exited;
    expect(exitInfo.signal).toBe("SIGKILL");
  });

  it("surfaces a warning on stopWarning if SIGKILL also doesn't reap the process (LEV-312)", async () => {
    // We can't truly make SIGKILL fail (the kernel rarely allows it), but
    // we can monkey-patch `process.kill` so the signal-0 liveness check
    // run AFTER SIGKILL returns "still alive." This exercises the warning
    // emission code path without needing an actual stuck pid.
    //
    // The real production path this simulates: pid is in uninterruptible
    // D-state (NFS hang, etc.), zombie accounting, or a containerized pid
    // mismatch — extremely rare, but when it happens lich should tell the
    // user rather than silently report success.
    const name = "kill-no-reap-svc";
    const handle = await startOwnedService({
      name,
      cmd: "trap '' TERM; echo READY; while true; do sleep 0.1; done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    await waitForReady(name);

    // Swap process.kill so:
    //   - the actual SIGKILL call still goes through (the test child needs
    //     to die or vitest hangs at teardown);
    //   - the signal-0 liveness check that runs ~500ms AFTER SIGKILL lies
    //     and reports "still alive" so we can verify the warning path.
    const real = process.kill.bind(process);
    let killSent = false;
    const fake = (pid: number, signal?: string | number): true => {
      // Let real signals through so the child actually dies.
      if (signal !== 0) {
        if (signal === "SIGKILL") killSent = true;
        return real(pid, signal);
      }
      // Liveness probe. Before SIGKILL is sent, behave normally (the
      // SIGTERM path's own ESRCH checks would behave wrong otherwise).
      // After SIGKILL, pretend the pid is still alive to exercise the
      // warning code path.
      if (!killSent) return real(pid, signal);
      // Simulate "pid still answers signal 0" — kill returns true.
      return true;
    };
    // Node typedefs require the cast; swapping for the duration of this
    // test only.
    process.kill = fake as unknown as typeof process.kill;
    try {
      await handle.stop(200);
      expect(handle.stopWarning).not.toBeNull();
      expect(handle.stopWarning).toMatch(/SIGKILL did not reap/);
      expect(handle.stopWarning).toContain(String(handle.pid));
    } finally {
      process.kill = real;
    }
  });

  it("is idempotent when called after the process has already exited", async () => {
    const name = "already-exited-svc";
    const handle = await startOwnedService({
      name,
      cmd: "echo done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    // Wait for exit BEFORE calling stop.
    const result = await handle.exited;
    expect(result.code).toBe(0);

    // Should resolve without throwing, without trying to signal.
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  /**
   * The bug class LEV-319 fixes: user `cmd:` spawns child processes
   * (think `bun run dev` → actual Express server, or any wrapper script).
   * Before the fix, lich's stop() SIGTERM'd just the leader PID; the
   * leader exited, the grandchild got reparented to launchd/init and kept
   * running — port still bound, db connections still open, ghost
   * processes accumulating per test run.
   *
   * The fix: spawn with `detached: true` (child becomes process group
   * leader), then send SIGTERM/SIGKILL to the entire group via the
   * negative-pid POSIX convention.
   *
   * This test asserts that a grandchild spawned by the user's cmd is
   * actually dead after handle.stop(). It's the regression that proves
   * the leak is closed.
   */
  it("kills grandchildren too (process group, LEV-319)", async () => {
    const name = "parent-with-grandchild";

    // The cmd is a one-liner that:
    //   1. Spawns a long-lived child process (sleep 600) and captures its PID
    //   2. Echoes "GRANDCHILD_PID=<pid>" so the test can capture it
    //   3. Keeps the parent alive itself (loops forever)
    // Both the parent and the grandchild are independent processes; if the
    // group-kill works, both will be reaped by handle.stop().
    const handle = await startOwnedService({
      name,
      cmd: 'sleep 600 & echo "GRANDCHILD_PID=$!"; while true; do sleep 1; done',
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    const parentPid = handle.pid;

    // Read the grandchild PID from the log file. The child echoes it
    // immediately, so a short wait is enough.
    let grandchildPid: number | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && grandchildPid === null) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const log = await readFile(serviceLogPath(STACK_ID, name), "utf8");
        const m = log.match(/GRANDCHILD_PID=(\d+)/);
        if (m) grandchildPid = Number(m[1]);
      } catch {
        /* file may not exist yet */
      }
    }
    expect(grandchildPid, "grandchild pid should be captured").not.toBeNull();
    expect(parentPid, "parent pid should exist").toBeTypeOf("number");

    // Pre-stop sanity: both alive.
    expect(isPidAlive(parentPid!)).toBe(true);
    expect(isPidAlive(grandchildPid!)).toBe(true);

    // The fix under test.
    await handle.stop();

    // Brief grace for the kernel to reap. Mirrors the supervisor's own
    // SIGKILL_VERIFY_GRACE_MS — if it's wrong here, it's wrong there.
    await new Promise((r) => setTimeout(r, 600));

    // Post-stop assertion: both gone. This is the load-bearing assertion;
    // before LEV-319, the grandchild was still alive here.
    expect(isPidAlive(parentPid!), "parent should be dead").toBe(false);
    expect(
      isPidAlive(grandchildPid!),
      `grandchild pid ${grandchildPid} should be dead (this was the LEV-319 bug)`,
    ).toBe(false);

    // And stopWarning should be null on the happy path.
    expect(handle.stopWarning).toBeNull();
  }, 10_000);
});

/** Helper: probe pid liveness without killing it. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startOwnedService — PWD canonicalization (LEV-300)", () => {
  /**
   * Regression: on macOS with case-insensitive APFS, the user can enter the
   * worktree via a wrong-case prefix (`cd /users/ryan/...` vs `cd /Users/...`).
   * `process.cwd()` faithfully reports the lowercase form they typed; the
   * kernel doesn't care because both resolve to the same inode. But any
   * downstream tool that does case-sensitive string matching on paths breaks
   * — most painfully, Docker Desktop's shared-folder enforcement rejects a
   * bind-mount with `/users/...` because its FilesharingDirectories list
   * has `/Users/...`. The supabase CLI (Go) builds bind-mount paths from
   * `$PWD`, inheriting the lowercase form from the parent shell, and
   * `supabase start` fails.
   *
   * The supervisor's contract (verified below): regardless of what case
   * variant or symlink the caller passes as `cwd`, the spawned child's
   * `$PWD` MUST equal `realpathSync.native(cwd)` — the canonical, symlink-
   * resolved, case-canonical absolute path.
   *
   * We use a symlink test rather than a case test because symlinks behave
   * the same on macOS, Linux, and CI Linux runners — the case dimension
   * only exists on case-insensitive filesystems. The supervisor code path
   * is the same in both cases (a single call to `realpathSync.native`).
   */
  it("injects PWD as the canonical realpath of cwd (symlink resolution proof)", async () => {
    // ARRANGE: a real directory + a symlink pointing at it. The symlink path
    // is a "different but valid" name for the same inode — exactly the
    // shape that triggers the LEV-300 bug on macOS.
    const realDir = await mkdtemp(join(tmpdir(), "lich-pwd-real-"));
    const linkPath = realDir + "-link";
    await symlink(realDir, linkPath);

    // Sanity-precondition for the assertion: the symlink path and its
    // canonical realpath are NOT string-equal. If they were, the test
    // wouldn't be exercising the bug. (Realistically this never fires; the
    // assertion documents the precondition.)
    const canonical = realpathSync.native(linkPath);
    expect(canonical).not.toBe(linkPath);

    const name = "pwd-symlink-svc";
    try {
      const handle = await startOwnedService({
        name,
        cmd: "printenv PWD",
        cwd: linkPath,
        // Pre-populate PWD with the symlink (uncanonical) form, mirroring
        // what the user's parent shell would inherit if they `cd`d via the
        // symlink. Without the fix this leaks straight into the child.
        env: { PWD: linkPath },
        logPath: serviceLogPath(STACK_ID, name),
      });

      await handle.exited;
      const log = await readLog(name);
      const printed = log.trim();

      // The spawned child must see the canonical realpath, not the
      // symlinked input. `printenv PWD` reads the env value as-is (no
      // shell intervention possible).
      expect(printed).toBe(canonical);
      expect(printed).not.toBe(linkPath);
    } finally {
      await rm(linkPath, { force: true });
      await rm(realDir, { recursive: true, force: true });
    }
  });

  it("the canonical PWD overrides any PWD the caller provided in spec.env", async () => {
    // Reinforces the layering: spec.env may carry a PWD inherited from
    // the parent shell (or planted by a future env_groups feature). The
    // supervisor's override is the last write, so even if the resolved
    // env contains a stale/wrong PWD, the spawned child sees the right one.
    const name = "pwd-override-svc";
    const handle = await startOwnedService({
      name,
      cmd: "printenv PWD",
      cwd: homeDir,
      env: { PWD: "/this/value/should/be/discarded" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    const printed = log.trim();
    const expected = realpathSync.native(homeDir);

    expect(printed).toBe(expected);
    expect(printed).not.toContain("discarded");
  });
});
