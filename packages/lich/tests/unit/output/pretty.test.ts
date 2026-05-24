import { describe, expect, it } from "vitest";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

describe("pretty output (non-TTY)", () => {
  it("emits `▶ phase` on begin and `✓ phase` on ok end", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("allocating ports");
    p.end("ok");
    await out.close();

    const lines = sink.lines();
    expect(lines).toEqual(["▶ allocating ports", "✓ allocating ports"]);
  });

  it("emits `✗ phase — message` when ended with fail + message", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("starting compose");
    p.end("fail", "exit code 1");
    await out.close();

    const lines = sink.lines();
    expect(lines).toEqual([
      "▶ starting compose",
      "✗ starting compose — exit code 1",
    ]);
  });

  it("emits `… phase` when ended with skip", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("seed db");
    p.end("skip", "no seed defined");
    await out.close();

    expect(sink.lines()).toEqual([
      "▶ seed db",
      "… seed db — no seed defined",
    ]);
  });

  it("renders phase steps as indented gray lines under the phase", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("allocating ports");
    p.step("allocating port for api");
    p.step("allocating port for web");
    p.end("ok");
    await out.close();

    expect(sink.lines()).toEqual([
      "▶ allocating ports",
      "  allocating port for api",
      "  allocating port for web",
      "✓ allocating ports",
    ]);
  });

  it("renders service status lines with the expected icon per state", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.service("api", "starting");
    out.service("api", "healthy");
    out.service("postgres", "initializing");
    out.service("web", "ready", "served at /");
    out.service("worker", "stopping");
    out.service("db", "failed", "exit 1");
    await out.close();

    // Each service line is tagged `[name] <icon> <state>` with optional suffix.
    expect(sink.lines()).toEqual([
      "[api] ▶ starting",
      "[api] ✓ healthy",
      "[postgres] … initializing",
      "[web] ✓ ready served at /",
      "[worker] ↓ stopping",
      "[db] ✗ failed exit 1",
    ]);
  });

  it("renders info lines as-is", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.info("stack id: dogfood-stack");
    await out.close();

    expect(sink.lines()).toEqual(["stack id: dogfood-stack"]);
  });

  it("renders a summary block with title, lines, and services as a table", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.summary({
      title: "stack up",
      lines: ["worktree: ~/foo", "dashboard: http://localhost:54000"],
      services: [
        { name: "api", state: "ready" },
        { name: "db", state: "failed" },
      ],
    });
    await out.close();

    // Services are aligned in a name/state table (LEV-301).
    // Padding: longest name is "api"/"db" → width 3; state column gets a
    // right-pad of 9 so port columns line up when present.
    expect(sink.lines()).toEqual([
      "stack up",
      "  worktree: ~/foo",
      "  dashboard: http://localhost:54000",
      "",
      "  services:",
      "    api  ready",
      "    db   failed",
    ]);
  });

  it("renders an extended summary with elapsed, ports, urls, and next hints", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.summary({
      title: "stack up",
      elapsedMs: 12_400,
      lines: ["stack_id: dogfood-stack-b0669f5c"],
      services: [
        {
          name: "supabase",
          state: "ready",
          ports: {
            api: 9001,
            db: 9002,
            db_shadow: 9003,
            db_pooler: 9004,
            studio: 9005,
            inbucket: 9006,
          },
        },
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

    expect(sink.lines()).toEqual([
      "stack up — 12.4s",
      "  stack_id: dogfood-stack-b0669f5c",
      "",
      "  services:",
      "    supabase  ready      6 ports",
      "    api       ready      1 port (9000)",
      "    web       ready      1 port (9007)",
      "",
      "  urls:",
      "    api  http://localhost:9000",
      "    web  http://localhost:9007",
      "",
      "  next:",
      "    lich logs  follow stack logs",
      "    lich down  stop the stack",
    ]);
  });

  it("renders a summary block with no services key", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.summary({
      title: "stack down",
      lines: ["stopped 3 services"],
    });
    await out.close();

    expect(sink.lines()).toEqual(["stack down", "  stopped 3 services"]);
  });

  it("renders an error block with title, detail, and hint", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.error({
      title: "failed to start api",
      detail: "exit code 1\nlast 2 lines:\nError: EADDRINUSE\n  at server",
      hint: "run `lich stacks` to see what's running",
    });
    await out.close();

    expect(sink.lines()).toEqual([
      "✗ failed to start api",
      "  exit code 1",
      "  last 2 lines:",
      "  Error: EADDRINUSE",
      "    at server",
      "  hint: run `lich stacks` to see what's running",
    ]);
  });

  it("renders an error block without a hint", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.error({
      title: "config invalid",
      detail: "missing services.api.image",
    });
    await out.close();

    expect(sink.lines()).toEqual([
      "✗ config invalid",
      "  missing services.api.image",
    ]);
  });

  it("appends elapsed time to phase-end when showTiming is true", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink, showTiming: true });
    const p = out.phase("allocate-ports");
    p.end("ok");
    await out.close();

    // The phase took ~0ms in this test; format is `Xs` to one decimal.
    // Match the suffix shape rather than an exact ms count.
    const lines = sink.lines();
    expect(lines[0]).toBe("▶ allocate-ports");
    expect(lines[1]).toMatch(/^✓ allocate-ports — \d+\.\d+s$/);
  });

  it("composes message + elapsed when both are present (showTiming)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink, showTiming: true });
    const p = out.phase("dependency-graph");
    p.end("ok", "3 levels");
    await out.close();

    const lines = sink.lines();
    expect(lines[1]).toMatch(/^✓ dependency-graph — 3 levels — \d+\.\d+s$/);
  });

  it("omits elapsed by default (back-compat default behavior)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("x");
    p.end("ok");
    await out.close();

    expect(sink.lines()).toEqual(["▶ x", "✓ x"]);
  });

  it("does not emit ANSI escape codes on a non-TTY stream", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("x");
    p.end("ok");
    out.service("api", "ready");
    out.summary({ title: "done", lines: [] });
    await out.close();

    // No ESC (0x1b) characters anywhere — color is gated on isTTY.
    expect(sink.text).not.toContain("\x1b");
  });
});
