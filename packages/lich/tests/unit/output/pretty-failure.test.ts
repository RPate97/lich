/**
 * Unit tests for the pretty renderer's `failure(...)` method (Plan 4 Task 11).
 *
 * The renderer is intentionally dumb — it receives a `FailureBlock` (produced
 * by `formatFailure` in `src/failure/formatter.ts`) and turns it into the
 * coloured terminal banner. These tests cover the two presentation rules the
 * acceptance criteria spell out:
 *
 *   1. With color (ANSI escapes around the title + hint, log tail indented
 *      one line per `logTail[i]`).
 *   2. Without color on non-TTY streams (plain text, deterministic byte-for-
 *      byte output suitable for CI logs and unit-test `toEqual` assertions).
 *
 * The captured-sink helper (`makeSink`) forces `isTTY=false` so each test
 * gets the deterministic non-TTY path. For the colour test we wrap the sink
 * in a thin object that re-exposes `isTTY=true`, which is enough to flip
 * the pretty renderer into colour mode.
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { FailureBlock } from "../../../src/failure/formatter.js";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/**
 * Strip every ANSI CSI sequence (`ESC [ ... letter`) from a string so the
 * test can assert on the visible characters independently of color. Matches
 * what `chalk-strip-ansi` does — but we don't pull a dependency for the one
 * place we need it.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Wrap a captured sink so the pretty renderer treats it as a TTY (and thus
 * emits ANSI). We can't mutate the existing `makeSink()` result because it
 * pins `isTTY=false` to keep the suite deterministic; instead we return a
 * tiny passthrough that forwards writes but reports `isTTY=true`.
 */
interface TTYCapturedStream extends Writable {
  text: string;
}

function makeTTYSink(): TTYCapturedStream {
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      (sink as TTYCapturedStream).text += chunk.toString();
      cb();
    },
  }) as TTYCapturedStream;
  sink.text = "";
  (sink as unknown as { isTTY: boolean }).isTTY = true;
  return sink;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pretty output — failure(block)", () => {
  it("renders the failure block with red title and indented log tail", async () => {
    const sink = makeTTYSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const block: FailureBlock = {
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["starting api...", "error: EADDRINUSE", "bye"],
      hint: "hint: run `lich stacks` to find what's using the port",
    };
    out.failure(block);
    await out.close();

    // ANSI is present (proves color path fired). Then strip it for the
    // structural assertions so a future palette change doesn't break this
    // test.
    expect(sink.text).toContain("\x1b[31m"); // red on the title
    expect(sink.text).toContain("\x1b[36m"); // cyan on the hint

    const plain = stripAnsi(sink.text).split("\n");
    // Drop trailing empty element from the trailing newline.
    if (plain[plain.length - 1] === "") plain.pop();

    expect(plain).toEqual([
      '✗ service "api" failed',
      "  exited with code 1 during startup",
      "  log tail:",
      "    starting api...",
      "    error: EADDRINUSE",
      "    bye",
      "  hint: run `lich stacks` to find what's using the port",
    ]);
  });

  it("renders without color on non-TTY streams", async () => {
    const sink = makeSink(); // isTTY=false
    const out = createOutput({ mode: "pretty", stream: sink });
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["starting api...", "error: EADDRINUSE"],
      hint: "hint: run `lich stacks` to find what's using the port",
    });
    await out.close();

    // No ANSI bytes at all on non-TTY — deterministic for CI logs.
    expect(sink.text).not.toContain("\x1b");
    expect(sink.lines()).toEqual([
      '✗ service "api" failed',
      "  exited with code 1 during startup",
      "  log tail:",
      "    starting api...",
      "    error: EADDRINUSE",
      "  hint: run `lich stacks` to find what's using the port",
    ]);
  });

  it("omits the log-tail section when logTail is empty", async () => {
    // Process-exit-immediate or a service that crashed before printing
    // anything legitimately has no tail. The block must still render
    // cleanly: title + reason + (optional) hint, no `log tail:` heading.
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.failure({
      title: 'service "exiter" failed',
      reason: "exited with code 1 during startup",
      logTail: [],
    });
    await out.close();

    expect(sink.lines()).toEqual([
      '✗ service "exiter" failed',
      "  exited with code 1 during startup",
    ]);
  });

  it("omits the hint line when hint is undefined", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["one line"],
    });
    await out.close();

    expect(sink.lines()).toEqual([
      '✗ service "api" failed',
      "  exited with code 1 during startup",
      "  log tail:",
      "    one line",
    ]);
  });

  it("preserves multi-line reasons by indenting each line", async () => {
    // Formatter today emits single-line reasons, but the renderer should
    // not assume that — a future formatter extension shouldn't garble its
    // output here.
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.failure({
      title: 'service "x" failed',
      reason: "first line of reason\nsecond line of reason",
      logTail: [],
    });
    await out.close();

    expect(sink.lines()).toEqual([
      '✗ service "x" failed',
      "  first line of reason",
      "  second line of reason",
    ]);
  });
});
