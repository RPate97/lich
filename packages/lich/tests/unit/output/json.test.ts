import { describe, expect, it } from "vitest";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

/** Parse NDJSON text into an array of events. */
function parseEvents(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (line === "") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

describe("json output", () => {
  it("emits one valid JSON object per line", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.info("hello");
    const p = out.phase("x");
    p.end("ok");
    await out.close();

    // Every newline-separated chunk parses as JSON.
    const events = parseEvents(sink.text);
    expect(events.length).toBe(3);
    expect(sink.text.endsWith("\n")).toBe(true);
  });

  it("emits phase_begin and phase_end events with correct fields", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("allocating ports");
    p.end("ok");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "phase_begin", name: "allocating ports" },
      { type: "phase_end", name: "allocating ports", status: "ok" },
    ]);
  });

  it("includes message on phase_end when provided", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("starting compose");
    p.end("fail", "exit code 1");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "phase_begin", name: "starting compose" },
      {
        type: "phase_end",
        name: "starting compose",
        status: "fail",
        message: "exit code 1",
      },
    ]);
  });

  it("emits phase_step events with name + step fields", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("allocating ports");
    p.step("allocating port for api");
    p.step("allocating port for web");
    p.end("ok");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "phase_begin", name: "allocating ports" },
      {
        type: "phase_step",
        name: "allocating ports",
        step: "allocating port for api",
      },
      {
        type: "phase_step",
        name: "allocating ports",
        step: "allocating port for web",
      },
      { type: "phase_end", name: "allocating ports", status: "ok" },
    ]);
  });

  it("emits info events", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.info("stack id: dogfood-stack");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "info", message: "stack id: dogfood-stack" },
    ]);
  });

  it("emits service events with state and optional detail", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.service("api", "starting");
    out.service("api", "ready", "served at /");
    out.service("db", "failed");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "service", name: "api", state: "starting" },
      {
        type: "service",
        name: "api",
        state: "ready",
        detail: "served at /",
      },
      { type: "service", name: "db", state: "failed" },
    ]);
  });

  it("emits a summary event with all fields", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.summary({
      title: "stack up",
      lines: ["worktree: ~/foo", "dashboard: http://localhost:54000"],
      services: [
        { name: "api", state: "ready" },
        { name: "db", state: "failed" },
      ],
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "summary",
        title: "stack up",
        lines: ["worktree: ~/foo", "dashboard: http://localhost:54000"],
        services: [
          { name: "api", state: "ready" },
          { name: "db", state: "failed" },
        ],
      },
    ]);
  });

  it("omits optional fields from summary when not provided", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.summary({ title: "stack down", lines: ["stopped 3 services"] });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      { type: "summary", title: "stack down", lines: ["stopped 3 services"] },
    ]);
  });

  it("emits an error event with all fields", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.error({
      title: "failed to start api",
      detail: "exit code 1\nlast line: EADDRINUSE",
      hint: "lich stacks",
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "error",
        title: "failed to start api",
        detail: "exit code 1\nlast line: EADDRINUSE",
        hint: "lich stacks",
      },
    ]);
  });

  it("omits hint from error when not provided", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.error({ title: "config invalid", detail: "missing services.api" });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "error",
        title: "config invalid",
        detail: "missing services.api",
      },
    ]);
  });

  it("emits no spinner or ANSI bytes", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("x");
    p.step("step");
    p.end("ok");
    await out.close();

    expect(sink.text).not.toContain("\x1b");
  });
});
