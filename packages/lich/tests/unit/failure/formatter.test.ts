import { describe, expect, it } from "vitest";

import {
  formatFailure,
  type FailureBlock,
  type FailureInput,
} from "../../../src/failure/formatter.js";
import type { ProcessExitFailure } from "../../../src/failure/process-exit.js";

describe("formatFailure — kind: 'exit'", () => {
  it("builds a block titled with the service name and a reason from the exit details", () => {
    const exit: ProcessExitFailure = {
      kind: "exit",
      exitCode: 1,
      signalName: null,
      stage: "during_startup",
    };
    const block = formatFailure({
      kind: "exit",
      service: "api",
      exit,
      logBuffer: "starting up\nerror: boom\n",
    });

    expect(block.title).toContain('"api"');
    expect(block.title).toContain("failed");

    expect(block.reason).toContain("1");
    expect(block.reason).toContain("startup");

    expect(block.logTail).toEqual(["starting up", "error: boom"]);

    expect(block.hint).toBeUndefined();
  });

  it("handles signal-kill exits without losing the signal name", () => {
    const exit: ProcessExitFailure = {
      kind: "signal",
      exitCode: null,
      signalName: "SIGKILL",
      stage: "after_ready",
    };
    const block = formatFailure({
      kind: "exit",
      service: "web",
      exit,
    });

    expect(block.title).toContain('"web"');
    expect(block.reason).toContain("SIGKILL");
    expect(block.reason).toContain("ready");
    expect(block.logTail).toEqual([]);
  });
});

describe("formatFailure — kind: 'timeout'", () => {
  it("builds a block naming the service and the deadline", () => {
    const block = formatFailure({
      kind: "timeout",
      service: "api",
      ms: 30_000,
      logBuffer: "trying...\n",
    });

    expect(block.title).toContain('"api"');
    expect(block.title).toContain("30s");
    expect(block.reason).toContain("30s");
    expect(block.logTail).toEqual(["trying..."]);
  });

  it("includes the phase label in the reason when present", () => {
    const block = formatFailure({
      kind: "timeout",
      service: "api",
      ms: 30_000,
      phase: "http_get",
    });

    expect(block.title).toContain("30s");
    expect(block.reason).toContain("http_get");
  });

  it("renders sub-second deadlines as ms", () => {
    const block = formatFailure({
      kind: "timeout",
      service: "api",
      ms: 1_500,
    });

    expect(block.title).toContain("1500ms");
  });

  it("renders whole minutes and hours with their suffix", () => {
    const twoMin = formatFailure({
      kind: "timeout",
      service: "x",
      ms: 120_000,
    });
    expect(twoMin.title).toContain("2m");

    const oneHour = formatFailure({
      kind: "timeout",
      service: "x",
      ms: 3_600_000,
    });
    expect(oneHour.title).toContain("1h");
  });
});

describe("formatFailure — kind: 'fail_when'", () => {
  it("quotes the matched line in the reason", () => {
    const block = formatFailure({
      kind: "fail_when",
      service: "api",
      matchedLine: "EADDRINUSE: address already in use :::3000",
      logBuffer: "starting\nEADDRINUSE: address already in use :::3000\n",
    });

    expect(block.title).toContain('"api"');
    expect(block.title).toContain("fail_when");
    expect(block.reason).toContain("EADDRINUSE: address already in use :::3000");
    expect(block.logTail.length).toBeGreaterThan(0);
  });

  it("escapes embedded double-quotes in the matched line so the reason stays unambiguous", () => {
    const block = formatFailure({
      kind: "fail_when",
      service: "api",
      matchedLine: 'Error: Cannot find module "./missing"',
    });

    expect(block.reason).toContain('\\"./missing\\"');
  });
});

describe("formatFailure — kind: 'capture_miss'", () => {
  it("names the capture key in both the title and the reason", () => {
    const block = formatFailure({
      kind: "capture_miss",
      service: "tunnel",
      captureKey: "url",
      logBuffer: "starting tunnel\n(no URL ever appeared)\n",
    });

    expect(block.title).toContain('"tunnel"');
    expect(block.title).toContain('"url"');
    expect(block.reason).toContain('"url"');
    expect(block.reason).toContain("did not match");
    expect(block.logTail).toEqual([
      "starting tunnel",
      "(no URL ever appeared)",
    ]);
  });
});

describe("formatFailure — log tail trimming", () => {
  it("trims the log tail to the last 20 lines (50 in → 20 out)", () => {
    const buffer =
      Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const block = formatFailure({
      kind: "exit",
      service: "x",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      logBuffer: buffer,
    });

    expect(block.logTail).toHaveLength(20);
    expect(block.logTail[0]).toBe("line 31");
    expect(block.logTail[19]).toBe("line 50");
  });

  it("handles an empty log buffer by producing logTail: []", () => {
    const block = formatFailure({
      kind: "exit",
      service: "x",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      logBuffer: "",
    });

    expect(block.logTail).toEqual([]);
    expect(block.title).toBeTruthy();
    expect(block.reason).toBeTruthy();
  });

  it("handles a missing log buffer (no logBuffer field) by producing logTail: []", () => {
    const block = formatFailure({
      kind: "timeout",
      service: "x",
      ms: 1_000,
    });

    expect(block.logTail).toEqual([]);
  });

  it("preserves a trailing partial line (no terminating newline) so the dying gasp is visible", () => {
    const block = formatFailure({
      kind: "exit",
      service: "x",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      logBuffer: "line one\nline two without newline",
    });

    expect(block.logTail).toEqual(["line one", "line two without newline"]);
  });

  it("normalizes CRLF line endings before splitting", () => {
    const block = formatFailure({
      kind: "exit",
      service: "x",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      logBuffer: "first\r\nsecond\r\nthird\r\n",
    });

    expect(block.logTail).toEqual(["first", "second", "third"]);
  });

  it("returns fewer than 20 lines when the buffer has fewer than 20 lines", () => {
    const block = formatFailure({
      kind: "exit",
      service: "x",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      logBuffer: "a\nb\nc\n",
    });
    expect(block.logTail).toEqual(["a", "b", "c"]);
  });
});

describe("formatFailure — hints", () => {
  it("provides a port-conflict hint when the fail_when match looks like EADDRINUSE", () => {
    const block = formatFailure({
      kind: "fail_when",
      service: "api",
      matchedLine: "Error: listen EADDRINUSE: address already in use :::3000",
    });

    expect(block.hint).toBeDefined();
    expect(block.hint).toContain("lich stacks");
  });

  it("provides a module-missing hint when the fail_when match looks like 'Cannot find module'", () => {
    const block = formatFailure({
      kind: "fail_when",
      service: "api",
      matchedLine: "Error: Cannot find module './missing'",
    });

    expect(block.hint).toBeDefined();
    expect(block.hint!.toLowerCase()).toContain("install");
  });

  it("omits the hint for fail_when matches with no recognized pattern", () => {
    const block = formatFailure({
      kind: "fail_when",
      service: "api",
      matchedLine: "PANIC: some custom failure mode",
    });

    expect(block.hint).toBeUndefined();
  });

  it("provides a generic timeout hint for kind: 'timeout'", () => {
    const block = formatFailure({
      kind: "timeout",
      service: "api",
      ms: 30_000,
    });

    expect(block.hint).toBeDefined();
    expect(block.hint).toContain("ready_when.timeout");
  });

  it("provides a capture-miss hint referencing `lich logs <service>`", () => {
    const block = formatFailure({
      kind: "capture_miss",
      service: "tunnel",
      captureKey: "url",
    });

    expect(block.hint).toBeDefined();
    expect(block.hint).toContain("lich logs tunnel");
  });

  it("omits the hint for kind: 'exit' (generic exits are too broad to hint usefully)", () => {
    const block = formatFailure({
      kind: "exit",
      service: "api",
      exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
    });

    expect(block.hint).toBeUndefined();
  });
});

describe("formatFailure — FailureBlock shape", () => {
  it("always populates title, reason, and logTail (logTail at least []) for every kind", () => {
    const cases: FailureInput[] = [
      {
        kind: "exit",
        service: "a",
        exit: { kind: "exit", exitCode: 1, signalName: null, stage: "during_startup" },
      },
      { kind: "timeout", service: "b", ms: 60_000 },
      { kind: "fail_when", service: "c", matchedLine: "boom" },
      { kind: "capture_miss", service: "d", captureKey: "k" },
    ];

    for (const input of cases) {
      const block: FailureBlock = formatFailure(input);
      expect(typeof block.title).toBe("string");
      expect(block.title.length).toBeGreaterThan(0);
      expect(typeof block.reason).toBe("string");
      expect(block.reason.length).toBeGreaterThan(0);
      expect(Array.isArray(block.logTail)).toBe(true);
    }
  });
});
