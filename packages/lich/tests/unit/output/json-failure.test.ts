import { describe, expect, it } from "vitest";

import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

function parseEvents(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

describe("json output — failure(block)", () => {
  it("emits a single ndjson line of type 'failure'", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.failure({
      title: 'service "api" failed',
      reason: "exited with code 1 during startup",
      logTail: ["starting api...", "error: EADDRINUSE"],
      hint: "hint: run `lich stacks` to find what's using the port",
    });
    await out.close();

    expect(sink.text.endsWith("\n")).toBe(true);
    expect(sink.text.split("\n").filter((l) => l !== "")).toHaveLength(1);

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "failure",
        title: 'service "api" failed',
        reason: "exited with code 1 during startup",
        log_tail: ["starting api...", "error: EADDRINUSE"],
        hint: "hint: run `lich stacks` to find what's using the port",
      },
    ]);
  });

  it("omits hint when the block has no hint", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.failure({
      title: 'service "exiter" failed',
      reason: "exited with code 1 during startup",
      logTail: [],
    });
    await out.close();

    const events = parseEvents(sink.text) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "failure",
      title: 'service "exiter" failed',
      reason: "exited with code 1 during startup",
      log_tail: [],
    });
    expect("hint" in events[0]).toBe(false);
  });

  it("preserves an empty log_tail as an empty array (not omitted)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.failure({
      title: 'service "x" failed',
      reason: "anything",
      logTail: [],
    });
    await out.close();

    const events = parseEvents(sink.text) as Array<Record<string, unknown>>;
    expect("log_tail" in events[0]).toBe(true);
    expect(events[0].log_tail).toEqual([]);
  });

  it("emits no ANSI bytes", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.failure({
      title: "x",
      reason: "y",
      logTail: ["z"],
      hint: "h",
    });
    await out.close();

    expect(sink.text).not.toContain("\x1b");
  });
});
