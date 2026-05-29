import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForCmdReady } from "../../../src/ready/cmd.js";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

function makeTmp(): string {
  // realpath: macOS tmpdir is symlinked (/var → /private/var), so `pwd` from
  // inside the spawned shell may not equal the mkdtemp path. Resolve up front
  // for consistent equality checks in tests.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lich-ready-cmd-")));
  tmpDirs.push(dir);
  return dir;
}

describe("waitForCmdReady", () => {
  it("resolves on the first attempt when the cmd exits 0", async () => {
    const dir = makeTmp();
    let attempts = 0;
    const start = Date.now();
    await waitForCmdReady({
      shellCmd: "true",
      env: {},
      cwd: dir,
      intervalMs: 25,
      onAttempt: () => {
        attempts += 1;
      },
    });
    const elapsed = Date.now() - start;

    expect(attempts).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });

  it("retries on non-zero exit until the cmd transitions to success", async () => {
    const dir = makeTmp();
    const marker = join(dir, "go");
    // The shell snippet succeeds only once `marker` exists; we create it from
    // a separate timer mid-run to force at least a couple of failed attempts
    // before success.
    const shellCmd = `test -f "${marker}"`;

    setTimeout(() => {
      writeFileSync(marker, "");
    }, 120);

    const exitCodes: Array<number | null> = [];
    await waitForCmdReady({
      shellCmd,
      env: {},
      cwd: dir,
      intervalMs: 30,
      onAttempt: (_attempt, exitCode) => {
        exitCodes.push(exitCode);
      },
    });

    // At least one failed attempt before success.
    expect(exitCodes.length).toBeGreaterThanOrEqual(2);
    const last = exitCodes[exitCodes.length - 1];
    expect(last).toBe(0);
    // All earlier attempts should be non-zero (test -f exits 1 on miss).
    for (let i = 0; i < exitCodes.length - 1; i += 1) {
      expect(exitCodes[i]).not.toBe(0);
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("uses a counter file to confirm multiple invocations occurred", async () => {
    const dir = makeTmp();
    const counterFile = join(dir, "count");
    const targetFile = join(dir, "ready");
    // Each invocation appends a byte to `counterFile`. On the 3rd byte we
    // create `targetFile`, which the success check sees only AFTER the
    // write — so the cmd succeeds the 4th time at the earliest.
    const shellCmd = [
      `printf x >> "${counterFile}"`,
      `bytes=$(wc -c < "${counterFile}" | tr -d ' ')`,
      `if [ "$bytes" -ge 3 ]; then touch "${targetFile}"; fi`,
      `test -f "${targetFile}" && [ "$bytes" -ge 4 ]`,
    ].join(" && ");

    let attempts = 0;
    await waitForCmdReady({
      shellCmd,
      env: {},
      cwd: dir,
      intervalMs: 20,
      onAttempt: () => {
        attempts += 1;
      },
    });

    expect(attempts).toBeGreaterThanOrEqual(4);
  });

  it("rejects with aborted when the AbortSignal fires mid-poll", async () => {
    const dir = makeTmp();
    const controller = new AbortController();
    // Cmd that never succeeds.
    const shellCmd = "false";

    setTimeout(() => controller.abort(), 60);

    await expect(
      waitForCmdReady({
        shellCmd,
        env: {},
        cwd: dir,
        intervalMs: 25,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("rejects with aborted when the signal is already aborted before the call", async () => {
    const dir = makeTmp();
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForCmdReady({
        shellCmd: "true",
        env: {},
        cwd: dir,
        intervalMs: 25,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("rejects immediately on a spawn error (invalid cwd)", async () => {
    // node spawn surfaces ENOENT for a missing cwd via the child's 'error' event.
    const missing = join(tmpdir(), `lich-ready-cmd-missing-${Date.now()}-${Math.random()}`);
    expect(existsSync(missing)).toBe(false);

    await expect(
      waitForCmdReady({
        shellCmd: "true",
        env: {},
        cwd: missing,
        intervalMs: 25,
      }),
    ).rejects.toThrow(/spawn failed/);
  });

  it("waits intervalMs between attempts (loose timing check)", async () => {
    const dir = makeTmp();
    const intervalMs = 60;
    const timestamps: number[] = [];

    setTimeout(
      () => {
        // Cancel after enough room for 3 attempts at intervalMs spacing.
        controller.abort();
      },
      intervalMs * 3 + 30,
    );

    const controller = new AbortController();
    await expect(
      waitForCmdReady({
        shellCmd: "false",
        env: {},
        cwd: dir,
        intervalMs,
        signal: controller.signal,
        onAttempt: () => {
          timestamps.push(Date.now());
        },
      }),
    ).rejects.toThrow(/abort/i);

    expect(timestamps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < timestamps.length; i += 1) {
      const gap = timestamps[i]! - timestamps[i - 1]!;
      // Each gap should be at least ~intervalMs minus jitter; we allow a
      // generous floor so slow CI doesn't false-fail.
      expect(gap).toBeGreaterThanOrEqual(intervalMs - 20);
    }
  });

  it("passes env to the spawned shell", async () => {
    const dir = makeTmp();
    const marker = join(dir, "saw-env");
    // The shell only succeeds if LICH_TEST_VAR is set to the expected value;
    // it also touches a marker so we can verify the env reached the child.
    const shellCmd = `[ "$LICH_TEST_VAR" = "ready-cmd-value" ] && touch "${marker}"`;

    await waitForCmdReady({
      shellCmd,
      env: { LICH_TEST_VAR: "ready-cmd-value", PATH: process.env.PATH ?? "" },
      cwd: dir,
      intervalMs: 25,
    });

    expect(existsSync(marker)).toBe(true);
  });

  it("runs in the provided cwd", async () => {
    const dir = makeTmp();
    const sentinel = join(dir, "in-cwd");
    // `pwd` writes to ./in-cwd — only succeeds if cwd === dir.
    await waitForCmdReady({
      shellCmd: `pwd > in-cwd-out && grep -qx "${dir}" in-cwd-out && touch "${sentinel}"`,
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      intervalMs: 25,
    });

    expect(existsSync(sentinel)).toBe(true);
  });
});
