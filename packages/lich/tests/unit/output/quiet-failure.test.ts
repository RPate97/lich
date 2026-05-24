/**
 * Unit tests for the quiet renderer's `failure(...)` method (Plan 4 Task 11).
 *
 * Contract per the spec acceptance criteria:
 *   - Quiet suppresses phase / info / service events as it always has, but
 *     a per-service failure block MUST still surface so even quiet users
 *     see failures.
 *   - The failure is emitted as a single NDJSON line on `errStream`
 *     (defaults to `process.stderr`), with the same shape as json mode's
 *     `failure` event (verified by shared use of `buildFailureEvent`).
 *   - The main `stream` (stdout) stays clean of the failure line so scripts
 *     parsing summary output don't trip over a sudden JSON event.
 */

import { describe, expect, it } from "vitest";

import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

describe("quiet output — failure(block)", () => {
  it("emits a single ndjson failure line on errStream (not on stdout)", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const out = createOutput({
      mode: "quiet",
      stream: stdout,
      errStream: stderr,
    });
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["starting api...", "error: EADDRINUSE"],
      hint: "hint: run `lich stacks` to find what's using the port",
    });
    await out.close();

    // Stdout must remain empty — quiet's whole point is that scripts can
    // grep the summary without per-event noise.
    expect(stdout.text).toBe("");

    // Stderr gets exactly one NDJSON line with the spec's event shape.
    expect(stderr.text.endsWith("\n")).toBe(true);
    const lines = stderr.text.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "failure",
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      log_tail: ["starting api...", "error: EADDRINUSE"],
      hint: "hint: run `lich stacks` to find what's using the port",
    });
  });

  it("omits hint when the block has no hint", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const out = createOutput({
      mode: "quiet",
      stream: stdout,
      errStream: stderr,
    });
    out.failure({
      title: 'service "exiter" failed',
      reason: "exited with code 1 during startup",
      logTail: [],
    });
    await out.close();

    const event = JSON.parse(stderr.text.trim()) as Record<string, unknown>;
    expect(event).toEqual({
      type: "failure",
      title: 'service "exiter" failed',
      reason: "exited with code 1 during startup",
      log_tail: [],
    });
    expect("hint" in event).toBe(false);
  });

  it("still suppresses phase / info / service events around the failure", async () => {
    // Regression: introducing failure() must not loosen quiet's existing
    // suppression of phase/info/service. The failure line still goes to
    // stderr; everything else stays empty on both streams.
    const stdout = makeSink();
    const stderr = makeSink();
    const out = createOutput({
      mode: "quiet",
      stream: stdout,
      errStream: stderr,
    });
    const p = out.phase("starting api");
    p.step("allocating port");
    out.info("noise");
    out.service("api", "starting");
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: [],
    });
    p.end("fail");
    await out.close();

    expect(stdout.text).toBe("");
    // Stderr contains only the single failure line (no leakage from
    // phase/info/service handlers).
    const stderrLines = stderr.text.split("\n").filter((l) => l !== "");
    expect(stderrLines).toHaveLength(1);
    expect(JSON.parse(stderrLines[0]).type).toBe("failure");
  });

  it("emits no ANSI bytes on either stream", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const out = createOutput({
      mode: "quiet",
      stream: stdout,
      errStream: stderr,
    });
    out.failure({
      title: "x",
      reason: "y",
      logTail: ["z"],
      hint: "h",
    });
    await out.close();

    expect(stdout.text).not.toContain("\x1b");
    expect(stderr.text).not.toContain("\x1b");
  });
});
