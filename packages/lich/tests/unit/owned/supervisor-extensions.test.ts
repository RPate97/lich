import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureStackDir,
  serviceLogPath,
} from "../../../src/state/directory.js";
import {
  runOneshot,
  startOwnedService,
} from "../../../src/owned/supervisor.js";

const STACK_ID = "test-stack-ext";

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "lich-owned-ext-test-"));
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
 * Same retry-read helper as supervisor.test.ts — the WriteStream's `end()`
 * flush can lag the child's exit by a tick or two on some platforms.
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

describe("startOwnedService — multi-port", () => {
  it("injects every entry in spec.ports as <envVar>=<port>", async () => {
    const name = "multi-port-svc";
    const handle = await startOwnedService({
      name,
      cmd: 'echo "h=$HTTP_PORT d=$DB_PORT"',
      cwd: homeDir,
      env: {},
      ports: {
        http: { envVar: "HTTP_PORT", port: 8001 },
        db: { envVar: "DB_PORT", port: 8002 },
      },
      logPath: serviceLogPath(STACK_ID, name),
    });

    const result = await handle.exited;
    expect(result.code).toBe(0);

    const log = await readLog(name);
    expect(log).toContain("h=8001 d=8002");
  });

  it("throws a config error if both portEnvVar and ports are set", async () => {
    const name = "conflict-svc";
    await expect(
      startOwnedService({
        name,
        cmd: "true",
        cwd: homeDir,
        env: {},
        portEnvVar: "PORT",
        port: 9000,
        ports: { http: { envVar: "HTTP_PORT", port: 9001 } },
        logPath: serviceLogPath(STACK_ID, name),
      }),
    ).rejects.toThrow(/cannot set both single-port.*and multi-port/);
  });
});

describe("runOneshot", () => {
  it("resolves cleanly when the command exits 0", async () => {
    const name = "oneshot-ok";
    await expect(
      runOneshot({
        name,
        cmd: "echo done",
        cwd: homeDir,
        env: {},
        oneshot: true,
        logPath: serviceLogPath(STACK_ID, name),
      }),
    ).resolves.toBeUndefined();

    const log = await readLog(name);
    expect(log).toContain("done");
  });

  it("rejects with exit code AND output tail when the command exits non-zero", async () => {
    const name = "oneshot-bad";
    let caught: unknown;
    try {
      await runOneshot({
        name,
        cmd: "echo bad; exit 7",
        cwd: homeDir,
        env: {},
        oneshot: true,
        logPath: serviceLogPath(STACK_ID, name),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("oneshot-bad");
    expect(msg).toContain("7");
    expect(msg).toContain("bad");
  });
});

describe("startOwnedService — stop_cmd", () => {
  /**
   * Cross-platform stop_cmd test: the running process polls for a sentinel
   * file and exits when it appears. The stop_cmd touches that sentinel.
   * Avoids signal-based teardown entirely, which is the whole point of
   * stop_cmd — the supervisor must not fall back to SIGTERM in this path.
   *
   * Why a sentinel instead of `kill -9 $(pgrep ...)`: pgrep -P semantics
   * differ between macOS BSD pgrep and Linux procps pgrep, and we want
   * the test to pass identically in both CI environments.
   */
  it("invokes stop_cmd to stop the service instead of sending signals", async () => {
    const name = "stop-cmd-svc";
    const sentinel = join(homeDir, "stop-now");
    const handle = await startOwnedService({
      name,
      // Trap-and-ignore TERM so we'd hang forever if the supervisor fell
      // back to the signal path. The only way out is the sentinel file.
      cmd: `trap '' TERM; echo READY; while [ ! -f "${sentinel}" ]; do sleep 0.05; done; echo SAW_SENTINEL; exit 0`,
      cwd: homeDir,
      env: {},
      stopCmd: `touch "${sentinel}"`,
      logPath: serviceLogPath(STACK_ID, name),
    });

    // Wait for READY so we know the trap is installed (avoids the same
    // race the Task 9 tests handle in waitForReady).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const log = await readFile(serviceLogPath(STACK_ID, name), "utf8");
        if (log.includes("READY")) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    await handle.stop();
    const result = await handle.exited;
    // Clean exit via the sentinel path, NOT via SIGKILL.
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    const log = await readLog(name);
    expect(log).toContain("SAW_SENTINEL");

    // And the sentinel actually exists — proves stop_cmd ran.
    // access() throws if the file's missing; we don't care about the
    // resolution value (bun returns null, node returns undefined).
    await access(sentinel);
  });

  it("falls back to SIGTERM→SIGKILL when stop_cmd is absent (Task 9 regression)", async () => {
    const name = "no-stop-cmd-svc";
    const handle = await startOwnedService({
      name,
      // Same stubborn-svc shape as supervisor.test.ts: ignore TERM, only
      // SIGKILL can stop it.
      cmd: "trap '' TERM; echo READY; while true; do sleep 0.1; done",
      cwd: homeDir,
      env: {},
      logPath: serviceLogPath(STACK_ID, name),
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const log = await readFile(serviceLogPath(STACK_ID, name), "utf8");
        if (log.includes("READY")) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    await handle.stop(200);
    const result = await handle.exited;
    expect(result.signal).toBe("SIGKILL");
  });

  it("runs stop_cmd with the same multi-port env as the start cmd", async () => {
    const name = "stop-cmd-env-svc";
    const sentinel = join(homeDir, "stop-now-env");
    const captured = join(homeDir, "captured-env");
    const handle = await startOwnedService({
      name,
      cmd: `trap '' TERM; echo "start_http=$HTTP_PORT"; while [ ! -f "${sentinel}" ]; do sleep 0.05; done; exit 0`,
      cwd: homeDir,
      env: {},
      ports: {
        http: { envVar: "HTTP_PORT", port: 8123 },
      },
      // stop_cmd records HTTP_PORT — proves env is wired through — and
      // creates the sentinel to release the start cmd.
      stopCmd: `echo "stop_http=$HTTP_PORT" > "${captured}"; touch "${sentinel}"`,
      logPath: serviceLogPath(STACK_ID, name),
    });

    // Wait for the start cmd to print its port (also proves multi-port
    // env injection on the start side is in effect).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const log = await readFile(serviceLogPath(STACK_ID, name), "utf8");
        if (log.includes("start_http=8123")) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    await handle.stop();
    await handle.exited;

    const capturedContents = await readFile(captured, "utf8");
    expect(capturedContents).toContain("stop_http=8123");
  });
});

