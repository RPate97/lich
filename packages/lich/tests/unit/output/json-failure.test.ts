/**
 * Unit tests for the JSON renderer's `failure(...)` method (Plan 4 Task 11).
 *
 * The JSON contract per the spec: a single NDJSON line of shape
 *   `{ "type": "failure", "title", "reason", "log_tail", "hint" }`
 *
 * `hint` is omitted when undefined so consumers using `in` / `Object.hasOwn`
 * checks don't see a phantom key. `log_tail` is snake_case to match the
 * matching field in `state.json`'s `failure_log_tail` and the spec wording.
 */

import { describe, expect, it } from "vitest";

import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

/** Parse NDJSON text into an array of events (mirrors json.test.ts). */
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

    // Exactly one line (terminated with \n).
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
    // Process-exit failures don't carry hints (per `inferHint`). The JSON
    // line MUST NOT carry a phantom `hint: undefined` key — downstream
    // consumers parse strictly.
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
    // log_tail is required by the schema even when empty so consumers can
    // pattern-match on `event.log_tail.length === 0` without an `in` check.
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
