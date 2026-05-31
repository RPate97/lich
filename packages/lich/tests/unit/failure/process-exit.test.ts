import { describe, expect, it } from "vitest";

import {
  ProcessExitWatcher,
  formatProcessExitFailure,
  type LifecycleStage,
  type ProcessExitFailure,
} from "../../../src/failure/process-exit.js";
import type { ExitResult, OwnedHandle } from "../../../src/owned/supervisor.js";

function fakeHandle(result: ExitResult): OwnedHandle {
  return {
    name: "fake-svc",
    pid: 12345,
    exited: Promise.resolve(result),
    stop: async () => {},
    stopWarning: null,
    logStartOffset: 0,
  };
}

describe("ProcessExitWatcher.wait", () => {
  it("resolves to a failure object when handle.exited resolves with non-zero code", async () => {
    const handle = fakeHandle({ code: 1, signal: null });
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "during_startup",
    });

    const failure = await watcher.wait();

    expect(failure).not.toBeNull();
    expect(failure?.kind).toBe("exit");
    expect(failure?.exitCode).toBe(1);
    expect(failure?.signalName).toBeNull();
    expect(failure?.stage).toBe("during_startup");
  });

  it("resolves to null when handle.exited resolves with code 0", async () => {
    const handle = fakeHandle({ code: 0, signal: null });
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "after_ready",
    });

    const failure = await watcher.wait();

    expect(failure).toBeNull();
  });

  it("captures the stage label from readSignal() at the moment of exit", async () => {
    // mutable stage: watcher samples lazily, not at construction
    let stage: LifecycleStage = "during_startup";
    let resolveExited!: (r: ExitResult) => void;
    const handle: OwnedHandle = {
      name: "fake-svc",
      pid: 12345,
      exited: new Promise<ExitResult>((resolve) => {
        resolveExited = resolve;
      }),
      stop: async () => {},
      stopWarning: null,
      logStartOffset: 0,
    };

    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => stage,
    });

    stage = "before_ready";
    resolveExited({ code: 2, signal: null });

    const failure = await watcher.wait();
    expect(failure?.stage).toBe("before_ready");
    expect(failure?.exitCode).toBe(2);
  });

  it("translates signal kill (SIGKILL) into a SignalExitFailure with signalName", async () => {
    const handle = fakeHandle({ code: null, signal: "SIGKILL" });
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "after_ready",
    });

    const failure = await watcher.wait();

    expect(failure).not.toBeNull();
    expect(failure?.kind).toBe("signal");
    expect(failure?.signalName).toBe("SIGKILL");
    expect(failure?.exitCode).toBeNull();
    expect(failure?.stage).toBe("after_ready");
  });

  it("returns the same cached promise on repeated calls", async () => {
    const handle = fakeHandle({ code: 1, signal: null });
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "during_startup",
    });

    const p1 = watcher.wait();
    const p2 = watcher.wait();

    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  it("handles signal kill with a non-SIGKILL signal name", async () => {
    const handle = fakeHandle({ code: null, signal: "SIGTERM" });
    const watcher = new ProcessExitWatcher(handle, {
      readSignal: () => "before_ready",
    });

    const failure = await watcher.wait();
    expect(failure?.kind).toBe("signal");
    expect(failure?.signalName).toBe("SIGTERM");
    expect(failure?.stage).toBe("before_ready");
  });
});

describe("formatProcessExitFailure", () => {
  it("renders exit code and stage in a readable way", () => {
    const failure: ProcessExitFailure = {
      kind: "exit",
      exitCode: 1,
      signalName: null,
      stage: "during_startup",
    };

    const msg = formatProcessExitFailure(failure);

    expect(msg).toContain("exited");
    expect(msg).toContain("1");
    expect(msg).toContain("startup");
  });

  it("renders signal kill with stage in a readable way", () => {
    const failure: ProcessExitFailure = {
      kind: "signal",
      exitCode: null,
      signalName: "SIGKILL",
      stage: "after_ready",
    };

    const msg = formatProcessExitFailure(failure);

    expect(msg).toContain("killed");
    expect(msg).toContain("SIGKILL");
    expect(msg).toContain("ready");
  });

  it("describes each lifecycle stage with distinct wording", () => {
    const base = {
      kind: "exit" as const,
      exitCode: 1,
      signalName: null,
    };
    const a = formatProcessExitFailure({ ...base, stage: "during_startup" });
    const b = formatProcessExitFailure({ ...base, stage: "before_ready" });
    const c = formatProcessExitFailure({ ...base, stage: "after_ready" });

    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});
