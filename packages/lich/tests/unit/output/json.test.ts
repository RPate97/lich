import { describe, expect, it } from "vitest";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

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

  it("includes elapsed_ms on phase_end when showTiming is set", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink, showTiming: true });
    const p = out.phase("dependency-graph");
    p.end("ok", "3 levels");
    await out.close();

    const events = parseEvents(sink.text) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "phase_begin", name: "dependency-graph" });
    expect(events[1]).toMatchObject({
      type: "phase_end",
      name: "dependency-graph",
      status: "ok",
      message: "3 levels",
    });
    expect(typeof events[1].elapsed_ms).toBe("number");
    expect(events[1].elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("omits elapsed_ms when showTiming is not set (back-compat)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("x");
    p.end("ok");
    await out.close();

    const events = parseEvents(sink.text) as Array<Record<string, unknown>>;
    expect(events[1]).toEqual({ type: "phase_end", name: "x", status: "ok" });
    expect(events[1].elapsed_ms).toBeUndefined();
  });

  it("emits a richer summary with services (with ports), urls, next, elapsed_ms", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.summary({
      title: "stack up",
      elapsedMs: 12_400,
      lines: ["stack_id: dogfood-stack-b0669f5c"],
      services: [
        { name: "api", state: "ready", ports: { default: 9000 } },
        { name: "web", state: "ready", ports: { default: 9007 } },
      ],
      urls: [
        { service: "api", url: "http://localhost:9000" },
        { service: "web", url: "http://localhost:9007" },
      ],
      next: [
        { cmd: "lich logs", description: "follow stack logs" },
        { cmd: "lich down", description: "stop the stack" },
      ],
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "summary",
        title: "stack up",
        lines: ["stack_id: dogfood-stack-b0669f5c"],
        services: [
          { name: "api", state: "ready", ports: { default: 9000 } },
          { name: "web", state: "ready", ports: { default: 9007 } },
        ],
        urls: [
          { service: "api", url: "http://localhost:9000" },
          { service: "web", url: "http://localhost:9007" },
        ],
        next: [
          { cmd: "lich logs", description: "follow stack logs" },
          { cmd: "lich down", description: "stop the stack" },
        ],
        elapsed_ms: 12_400,
      },
    ]);
  });

  it("omits new optional summary fields when not provided (back-compat)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.summary({
      title: "stack up",
      lines: ["worktree: ~/foo"],
      services: [{ name: "api", state: "ready" }],
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "summary",
        title: "stack up",
        lines: ["worktree: ~/foo"],
        services: [{ name: "api", state: "ready" }],
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

  it("emits a phase_update event per `update(...)` call", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("down: stopping owned services (1/3: api)");
    p.update("down: stopping owned services (2/3: web)");
    p.update("down: stopping owned services (3/3: worker)");
    p.end("ok", "stopped owned services (3/3)");
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "phase_begin",
        name: "down: stopping owned services (1/3: api)",
      },
      {
        type: "phase_update",
        name: "down: stopping owned services (2/3: web)",
      },
      {
        type: "phase_update",
        name: "down: stopping owned services (3/3: worker)",
      },
      {
        type: "phase_end",
        name: "down: stopping owned services (3/3: worker)",
        status: "ok",
        message: "stopped owned services (3/3)",
      },
    ]);
  });

  it("phase_end carries the latest updated name, not the initial one", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    const p = out.phase("initial");
    p.update("midway");
    p.update("final");
    p.end("ok");
    await out.close();

    const events = parseEvents(sink.text) as Array<Record<string, unknown>>;
    const end = events.find((e) => e.type === "phase_end");
    expect(end).toBeDefined();
    expect(end!.name).toBe("final");
  });

  it("emits lifecycle_entry_start and lifecycle_entry_complete events with snake_case fields", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.lifecycleEntryStart({
      phase: "before_up",
      index: 0,
      total: 2,
      cmd: "pnpm install",
    });
    out.lifecycleEntryComplete({
      phase: "before_up",
      index: 0,
      total: 2,
      cmd: "pnpm install",
      exitCode: 0,
      elapsedMs: 32_100,
      stderrTail: "warn: peer dep",
      logPath: "/tmp/lich/logs/before_up.log",
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "lifecycle_entry_start",
        phase: "before_up",
        index: 0,
        total: 2,
        cmd: "pnpm install",
      },
      {
        type: "lifecycle_entry_complete",
        phase: "before_up",
        index: 0,
        total: 2,
        cmd: "pnpm install",
        exit_code: 0,
        elapsed_ms: 32_100,
        stderr_tail: "warn: peer dep",
        log_path: "/tmp/lich/logs/before_up.log",
      },
    ]);
  });

  it("omits log_path from lifecycle_entry_complete when undefined", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "json", stream: sink });
    out.lifecycleEntryComplete({
      phase: "after_down",
      index: 1,
      total: 3,
      cmd: "supabase stop",
      exitCode: 0,
      elapsedMs: 1_000,
      stderrTail: "",
    });
    await out.close();

    expect(parseEvents(sink.text)).toEqual([
      {
        type: "lifecycle_entry_complete",
        phase: "after_down",
        index: 1,
        total: 3,
        cmd: "supabase stop",
        exit_code: 0,
        elapsed_ms: 1_000,
        stderr_tail: "",
      },
    ]);
  });
});
