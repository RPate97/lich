import { describe, expect, it } from "vitest";

import { failOnExitDuringReady } from "../../../src/ready/process-exit-race.js";
import {
  ProcessExitWatcher,
  type ProcessExitFailure,
} from "../../../src/failure/process-exit.js";
import type { ExitResult, OwnedHandle } from "../../../src/owned/supervisor.js";

function fakeHandle(result: ExitResult, delayMs: number): OwnedHandle {
  return {
    name: "fake-svc",
    pid: 12345,
    exited: new Promise<ExitResult>((resolve) =>
      setTimeout(() => resolve(result), delayMs),
    ),
    stop: async () => {},
    stopWarning: null,
  };
}

function neverResolvingReady(): Promise<void> {
  return new Promise<void>(() => {
    /* no-op */
  });
}

describe("failOnExitDuringReady", () => {
  it("rejects when the process exits non-zero during the wait, carrying the watcher's failure as Error.cause", async () => {
    const handle = fakeHandle({ code: 254, signal: null }, 20);
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "before_ready",
    });

    const result = failOnExitDuringReady({
      readyPromise: neverResolvingReady(),
      exitWatcher: watcher,
      serviceName: "test-svc",
    });

    await expect(result).rejects.toThrow(/test-svc/);

    try {
      await result;
      throw new Error("expected failOnExitDuringReady to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error & { cause?: ProcessExitFailure }).cause;
      expect(cause).toBeDefined();
      expect(cause?.kind).toBe("exit");
      expect(cause?.exitCode).toBe(254);
      expect(cause?.signalName).toBeNull();
      expect(cause?.stage).toBe("before_ready");
    }
  });

  it("rejects when the process exits with code 0 during the wait — clean-exit must not hang", async () => {
    // Without the fix, this test would HANG forever — the never-resolving
    // ready and an unsynthesized clean exit both never settle. The primitive
    // must synthesize a ProcessExitFailure with exitCode=0 so the race rejects.
    const handle = fakeHandle({ code: 0, signal: null }, 20);
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "before_ready",
    });

    const result = failOnExitDuringReady({
      readyPromise: neverResolvingReady(),
      exitWatcher: watcher,
      serviceName: "test-svc",
    });

    await expect(result).rejects.toThrow(/test-svc/);

    try {
      await result;
      throw new Error("expected failOnExitDuringReady to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error & { cause?: ProcessExitFailure }).cause;
      expect(cause).toBeDefined();
      expect(cause?.kind).toBe("exit");
      expect(cause?.exitCode).toBe(0);
      expect(cause?.signalName).toBeNull();
      expect(cause?.stage).toBe("before_ready");
    }
  });

  it("rejects when the process is killed by signal during the wait, carrying the signal name", async () => {
    const handle = fakeHandle({ code: null, signal: "SIGTERM" }, 20);
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "before_ready",
    });

    const result = failOnExitDuringReady({
      readyPromise: neverResolvingReady(),
      exitWatcher: watcher,
      serviceName: "test-svc",
    });

    try {
      await result;
      throw new Error("expected failOnExitDuringReady to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error & { cause?: ProcessExitFailure }).cause;
      expect(cause).toBeDefined();
      expect(cause?.kind).toBe("signal");
      expect(cause?.signalName).toBe("SIGTERM");
      expect(cause?.exitCode).toBeNull();
    }
  });

  it("resolves with the ready promise's value when ready wins the race", async () => {
    const neverExitsHandle: OwnedHandle = {
      name: "fake-svc",
      pid: 12345,
      exited: new Promise(() => {}),
      stop: async () => {},
      stopWarning: null,
    };
    const watcher = new ProcessExitWatcher(neverExitsHandle, {
      readSignal: () => "before_ready",
    });

    const readyPromise = new Promise<void>((resolve) =>
      setTimeout(() => resolve(), 10),
    );

    await expect(
      failOnExitDuringReady({
        readyPromise,
        exitWatcher: watcher,
        serviceName: "test-svc",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails FAST when the process exits in <100ms — must not wait the full ready_when timeout", async () => {
    // A process exiting in <100ms must reject immediately, not wait for the
    // simulated 30s ready timeout to fire.
    const handle = fakeHandle({ code: 1, signal: null }, 50);
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "before_ready",
    });

    // Simulated long ready_when timeout — never actually fires in the budget.
    const slowReady = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("simulated 30s timeout")), 30_000),
    );

    const startMs = Date.now();
    try {
      await failOnExitDuringReady({
        readyPromise: slowReady,
        exitWatcher: watcher,
        serviceName: "test-svc",
      });
      throw new Error("expected failOnExitDuringReady to reject");
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      expect(
        elapsedMs,
        `regression: failOnExitDuringReady waited ${elapsedMs}ms; ` +
          `should have failed within 2s of the process exit at ~50ms. ` +
          `If this test fails near 30000ms, the primitive is hanging on ` +
          `the ready evaluator instead of short-circuiting on the exit.`,
      ).toBeLessThan(2_000);

      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error & { cause?: ProcessExitFailure }).cause;
      expect(cause?.kind).toBe("exit");
      expect(cause?.exitCode).toBe(1);
    }
  });
});
