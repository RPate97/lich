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
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
