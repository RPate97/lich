/**
 * Integration test: `LogTail` reading from a real supervisor-spawned
 * owned service's log file.
 *
 * This file is the architectural proof-of-concept for Plan 4's failure-
 * surfacing design. Every later task (fail_when, capture, the dashboard
 * live-tail) layers onto the same primitive: the supervisor writes the
 * log file via a dup'd file fd (`stdio: ["ignore", logFd, logFd]`) and
 * LogTail opens an INDEPENDENT O_RDONLY fd on the same path and polls
 * for growth. The two fds share no in-process state — coherence is
 * guaranteed by the kernel, not by us.
 *
 * If this test passes, the fd-separation premise holds:
 *   - the supervisor's writes are visible to LogTail's reads
 *   - LogTail's reads do not interfere with the supervisor's writes
 *   - the orchestrator can stop a service mid-stream without crashing
 *     a still-running LogTail (and vice versa)
 *
 * If it fails, every Plan 4 watcher built on LogTail is unsound and
 * we need a different reading strategy. So this test is intentionally
 * small (one happy-path service, one cleanup-after-stop scenario) but
 * load-bearing.
 *
 * Pattern: lifted verbatim from `owned/supervisor.test.ts`. Same
 * `LICH_HOME` override, same `ensureStackDir` + `serviceLogPath`
 * usage. The supervisor's real public API is exercised — no mocks,
 * no test doubles. If the supervisor changes its log-fd handling
 * tomorrow, this test will catch the regression before any downstream
 * watcher sees it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureStackDir,
  serviceLogPath,
} from "../../../src/state/directory.js";
import { startOwnedService } from "../../../src/owned/supervisor.js";
import { LogTail } from "../../../src/logs/tail.js";

const STACK_ID = "test-stack";

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  // Mirror the supervisor test setup exactly. The supervisor reads
  // `LICH_HOME` indirectly via `serviceLogPath` callers; this same
  // override makes the log file land in the test's tmpdir.
  homeDir = await mkdtemp(join(tmpdir(), "lich-tail-integration-"));
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

describe("LogTail × supervisor integration", () => {
  it("reads lines from a real supervisor-spawned service's log", async () => {
    // The 5-tick test from the task description. A short shell loop
    // emits a deterministic sequence; LogTail subscribes; we assert
    // all 5 ticks land before the service exits naturally.
    //
    // Total wall-clock budget: ~300ms (5 sleeps × 50ms + spawn cost).
    // The deferred-on-fifth-tick pattern avoids any arbitrary sleeps
    // here — the test resolves as soon as the load-bearing event
    // happens, exactly per the task notes ("Do not let it sleep
    // arbitrary durations — wait on a deferred that resolves on the
    // 5th tick").
    const name = "tick-svc";
    const logPath = serviceLogPath(STACK_ID, name);

    // Construct + start the LogTail BEFORE the supervisor spawn. This
    // covers the realistic orchestrator ordering: in `up.ts`, the
    // LogTail is wired up before the service starts emitting, so we
    // shouldn't miss the first line. Polling at 10ms keeps total
    // runtime tight without changing the behavior under test.
    const tail = new LogTail({ logPath, intervalMs: 10 });

    const received: string[] = [];
    const fifthTickDeferred = makeDeferred<void>();
    tail.onLine((line) => {
      // Only count ticks, not the trailing newline / empty trailers.
      if (/^tick \d+$/.test(line)) {
        received.push(line);
        if (received.length === 5) fifthTickDeferred.resolve();
      }
    });
    await tail.start();

    // Spawn the supervised service. The shell loop is deterministic:
    // 5 echoes, 50ms apart, then exits naturally. Each `echo` flushes
    // a line (the shell does line-buffered output to the fd by default
    // because the fd is connected to a regular file, not a pipe — but
    // `echo` is line-buffered regardless because it's a builtin).
    const handle = await startOwnedService({
      name,
      cmd: 'for i in 1 2 3 4 5; do echo "tick $i"; sleep 0.05; done',
      cwd: homeDir,
      env: {},
      logPath,
    });

    try {
      // Wait on the deferred — no arbitrary sleep, no polling. The
      // 2s timeout exists only to bound test failures; on the happy
      // path, the deferred resolves in ~300ms.
      await withTimeout(
        fifthTickDeferred.promise,
        2000,
        "fifth tick never arrived within 2s",
      );

      // Every tick landed in order, with no duplicates and no missing
      // lines. This is the load-bearing assertion — proves the
      // supervisor's writes are visible to the LogTail's reads, and
      // proves the LogTail's line splitting handles a streaming
      // sequence correctly.
      expect(received).toEqual([
        "tick 1",
        "tick 2",
        "tick 3",
        "tick 4",
        "tick 5",
      ]);

      // The shell exits naturally after the loop. Wait for the
      // supervisor's `exited` promise so we know there's no live
      // child process when the test cleans up.
      const result = await handle.exited;
      expect(result.code).toBe(0);
    } finally {
      // Always stop the tail, even on failure. The supervisor's child
      // is independent of the LogTail; stop() releases the LogTail's
      // poll interval. Without this, vitest would hang at teardown.
      await tail.stop();
    }
  });

  it("closes cleanly when the supervised service is stopped mid-stream", async () => {
    // Second scenario: explicit `handle.stop()` mid-stream. Verifies
    // the LogTail tolerates the service being torn down before it
    // exits naturally — important because the orchestrator's
    // cancellation path stops services explicitly rather than waiting
    // for natural exit.
    //
    // After stop(), the tail's stop() must also resolve cleanly. The
    // critical property: no late reads on a torn-down fd, no crashed
    // poll loop, no unhandled rejections. We can't directly assert
    // "no leaked anything"; vitest's runner is the implicit verifier
    // (an unhandled rejection or open handle would surface here).
    const name = "long-lived-svc";
    const logPath = serviceLogPath(STACK_ID, name);

    const tail = new LogTail({ logPath, intervalMs: 10 });

    let firstLineSeen = false;
    const firstLine = makeDeferred<void>();
    tail.onLine((line) => {
      if (line === "ready") {
        firstLineSeen = true;
        firstLine.resolve();
      }
    });
    await tail.start();

    // Long-lived service: print "ready", then loop forever printing
    // a tick line per second. The orchestrator-style stop() below
    // tears it down before the loop finishes.
    const handle = await startOwnedService({
      name,
      cmd: 'echo ready; while true; do echo "still-alive"; sleep 1; done',
      cwd: homeDir,
      env: {},
      logPath,
    });

    try {
      // Wait for the "ready" line to confirm the integration is live.
      await withTimeout(
        firstLine.promise,
        2000,
        "service never emitted 'ready' within 2s",
      );
      expect(firstLineSeen).toBe(true);

      // Stop the service via the supervisor — this is the path the
      // orchestrator uses on Ctrl-C, on per-service failure, and on
      // `lich down`. The supervisor signals the process group and
      // (when the leader's sleep is killed) waits for natural exit.
      await handle.stop();

      // The LogTail must stop cleanly too. If the LogTail were
      // holding a fd between ticks (it shouldn't — we open/close per
      // tick), or if it had a stale offset that the closed fd
      // couldn't satisfy, stop() would hang or throw here.
      await expect(tail.stop()).resolves.toBeUndefined();

      // Idempotent: stopping again is a no-op.
      await expect(tail.stop()).resolves.toBeUndefined();
    } finally {
      // Belt-and-braces: ensure both are stopped even if a prior
      // assertion threw. Both are idempotent so this is safe.
      await handle.stop().catch(() => {});
      await tail.stop().catch(() => {});
    }
  });
});

/**
 * Promise helper: returns an object with `.promise`, `.resolve`, `.reject`.
 * Used by the tests to wait on a specific event (the 5th tick, the first
 * "ready" line) without arbitrary sleeps.
 *
 * Local rather than imported — there's only two callsites in this file,
 * and an inline helper keeps the test self-contained.
 */
function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Race a promise against a timeout. Resolves to the wrapped promise's
 * value on success, or rejects with `message` if `ms` elapses first.
 *
 * Cleans up the timeout when the wrapped promise wins — otherwise we'd
 * leak a setTimeout for every test, which vitest tolerates but is
 * untidy and slows down test shutdown unnecessarily.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
