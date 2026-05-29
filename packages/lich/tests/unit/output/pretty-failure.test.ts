import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { FailureBlock } from "../../../src/failure/formatter.js";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

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

    expect(sink.text).toContain("\x1b[31m"); // red title
    expect(sink.text).toContain("\x1b[36m"); // cyan hint

    const plain = stripAnsi(sink.text).split("\n");
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
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["starting api...", "error: EADDRINUSE"],
      hint: "hint: run `lich stacks` to find what's using the port",
    });
    await out.close();

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
