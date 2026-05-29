import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOutput } from "../../../src/output/index.js";
import {
  formatLifecycleEntryComplete,
  formatLifecycleEntryStart,
} from "../../../src/output/pretty.js";
import { makeSink } from "./helpers.js";

interface TTYCapturedStream extends Writable {
  text: string;
}
function makeTTYSink(columns: number): TTYCapturedStream {
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      (sink as TTYCapturedStream).text += chunk.toString();
      cb();
    },
  }) as TTYCapturedStream;
  sink.text = "";
  (sink as unknown as { isTTY: boolean; columns: number }).isTTY = true;
  (sink as unknown as { isTTY: boolean; columns: number }).columns = columns;
  return sink;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

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

    expect(sink.text).not.toContain("\x1b");
  });
});

describe("pretty output — phase update (non-TTY)", () => {
  it("emits a new ▶ line each time the phase's name is updated", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("down: stopping owned services (1/3: api)");
    p.update("down: stopping owned services (2/3: web)");
    p.update("down: stopping owned services (3/3: worker)");
    p.end("ok", "stopped owned services (3/3)");
    await out.close();

    expect(sink.lines()).toEqual([
      "▶ down: stopping owned services (1/3: api)",
      "▶ down: stopping owned services (2/3: web)",
      "▶ down: stopping owned services (3/3: worker)",
      "✓ down: stopping owned services (3/3: worker) — stopped owned services (3/3)",
    ]);
  });

  it("renders elapsed time on phase end after updates when showTiming is true", async () => {
    // elapsed_ms anchored to original begin, not last update — covers full phase span
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink, showTiming: true });
    const p = out.phase("down: running before_down hooks (1/2)");
    p.update("down: running before_down hooks (2/2)");
    p.end("ok", "hooks done");
    await out.close();

    const lines = sink.lines();
    expect(lines[0]).toBe("▶ down: running before_down hooks (1/2)");
    expect(lines[1]).toBe("▶ down: running before_down hooks (2/2)");
    expect(lines[2]).toMatch(
      /^✓ down: running before_down hooks \(2\/2\) — hooks done — \d+\.\d+s$/,
    );
  });

  it("end(name) uses the latest updated name (not the initial one)", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("starting label");
    p.update("middle label");
    p.update("final label");
    p.end("ok");
    await out.close();

    const lines = sink.lines();
    expect(lines[lines.length - 1]).toBe("✓ final label");
  });
});

describe("pretty output (TTY) — spinner truncation on update", () => {
  function makeTTYSink(columns: number): TTYCapturedStream {
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        (sink as TTYCapturedStream).text += chunk.toString();
        cb();
      },
    }) as TTYCapturedStream;
    sink.text = "";
    (sink as unknown as { isTTY: boolean; columns: number }).isTTY = true;
    (sink as unknown as { isTTY: boolean; columns: number }).columns = columns;
    return sink;
  }

  it("truncates an updated spinner name to fit a 40-col terminal", async () => {
    const sink = makeTTYSink(40);
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("down: stopping owned services (1/14: api)");
    p.update(
      "down: stopping owned services (14/14: a-very-long-final-service-name)",
    );
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    const frames = plain.split("\r").filter((s) => s.includes("▶"));
    const lastBeginFrame = frames[frames.length - 1];
    const updatedFrame = lastBeginFrame.split("\n")[0];
    expect(updatedFrame.length).toBeLessThanOrEqual(40);
    expect(updatedFrame.startsWith("▶ ")).toBe(true);
    expect(updatedFrame).toContain("stopping owned services");
  });

  it("preserves an updated name on a 300-col terminal", async () => {
    const sink = makeTTYSink(300);
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase("down: stopping owned services (1/14: api)");
    const updatedName =
      "down: stopping owned services (14/14: a-very-long-final-service-name)";
    p.update(updatedName);
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    expect(plain).toContain(updatedName);
  });
});

describe("pretty output (TTY) — spinner truncation", () => {
  const ELEVEN_SERVICES = [
    "agentic-workflows-worker",
    "alerts-worker",
    "bulk-upload-worker",
    "compliance-worker",
    "data-sync-worker",
    "metrics-worker",
    "notifications-worker",
    "person-edd-worker",
    "reports-worker",
    "scheduled-jobs-worker",
    "transaction-worker",
  ];
  const PHASE_NAME = `start 2/2 (${ELEVEN_SERVICES.join(", ")})`;

  it("truncates the initial spinner frame to fit a 80-col terminal", async () => {
    const sink = makeTTYSink(80);
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase(PHASE_NAME);
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    const firstFrame = plain.split("\r")[0];
    expect(firstFrame.startsWith("▶ ")).toBe(true);
    expect(firstFrame.length).toBeLessThanOrEqual(80);
    expect(firstFrame).toContain("start 2/2 (");
    expect(firstFrame).toMatch(/, … \+\d+ more\)$/);
  });

  it("preserves the full name on a wide terminal", async () => {
    const sink = makeTTYSink(300);
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase(PHASE_NAME);
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    const firstFrame = plain.split("\r")[0];
    expect(firstFrame).toBe(`▶ ${PHASE_NAME}`);
    for (const name of ELEVEN_SERVICES) {
      expect(firstFrame).toContain(name);
    }
  });

  it("degrades to a bare count form on a 40-col terminal", async () => {
    const sink = makeTTYSink(40);
    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase(PHASE_NAME);
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    const firstFrame = plain.split("\r")[0];
    expect(firstFrame.length).toBeLessThanOrEqual(40);
    expect(firstFrame).toBe("▶ start 2/2 (11 items)");
  });

  it("falls back to 80-col default when the TTY reports no columns", async () => {
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        (sink as TTYCapturedStream).text += chunk.toString();
        cb();
      },
    }) as TTYCapturedStream;
    sink.text = "";
    (sink as unknown as { isTTY: boolean }).isTTY = true;

    const out = createOutput({ mode: "pretty", stream: sink });
    const p = out.phase(PHASE_NAME);
    p.end("ok");
    await out.close();

    const plain = stripAnsi(sink.text);
    const firstFrame = plain.split("\r")[0];
    expect(firstFrame.length).toBeLessThanOrEqual(80);
    expect(firstFrame).toContain("start 2/2 (");
    expect(firstFrame).toMatch(/, … \+\d+ more\)$/);
  });
});

describe("pretty output: lifecycle entry lines", () => {
  const LONG_CMD =
    "pnpm install --frozen-lockfile --offline --workspace-deps --shamefully-hoist";

  it("formatLifecycleEntryStart: emits `▶ <phase> (i/N): <cmd>` line shape", () => {
    expect(
      formatLifecycleEntryStart(
        {
          phase: "before_up",
          index: 0,
          total: 4,
          cmd: "pnpm install workspace deps",
        },
        300,
      ),
    ).toBe("▶ before_up (1/4): pnpm install workspace deps");
  });

  it("formatLifecycleEntryStart: counter is 1-based; index is 0-based", () => {
    expect(
      formatLifecycleEntryStart(
        { phase: "after_up", index: 2, total: 5, cmd: "echo three" },
        300,
      ),
    ).toBe("▶ after_up (3/5): echo three");
  });

  it("formatLifecycleEntryStart: truncates the cmd to fit 80-col terminal", () => {
    const line = formatLifecycleEntryStart(
      { phase: "before_up", index: 0, total: 4, cmd: LONG_CMD },
      80,
    );
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.startsWith("▶ before_up (1/4): ")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  it("formatLifecycleEntryStart: hard-truncates at very narrow 40-col terminal", () => {
    const line = formatLifecycleEntryStart(
      { phase: "before_up", index: 0, total: 4, cmd: LONG_CMD },
      40,
    );
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.startsWith("▶ ")).toBe(true);
    expect(line).toContain("(1/4)");
  });

  it("formatLifecycleEntryStart: preserves the full line on a 300-col terminal", () => {
    const line = formatLifecycleEntryStart(
      { phase: "before_up", index: 0, total: 4, cmd: LONG_CMD },
      300,
    );
    expect(line).toBe(`▶ before_up (1/4): ${LONG_CMD}`);
  });

  it("formatLifecycleEntryStart: reduces multi-line cmd to its first non-empty line", () => {
    const line = formatLifecycleEntryStart(
      {
        phase: "before_up",
        index: 0,
        total: 1,
        cmd: "\n  pnpm install\n  pnpm run build\n",
      },
      300,
    );
    expect(line).toBe("▶ before_up (1/1): pnpm install");
  });

  it("formatLifecycleEntryComplete: emits `✓ <phase> (i/N) — <elapsed>` on exit 0", () => {
    expect(
      formatLifecycleEntryComplete({
        phase: "before_up",
        index: 0,
        total: 4,
        exitCode: 0,
        elapsedMs: 32_100,
      }),
    ).toBe("✓ before_up (1/4) — 32.1s");
  });

  it("formatLifecycleEntryComplete: emits `✗` on non-zero exit", () => {
    expect(
      formatLifecycleEntryComplete({
        phase: "before_down",
        index: 1,
        total: 3,
        exitCode: 1,
        elapsedMs: 1_234,
      }),
    ).toBe("✗ before_down (2/3) — 1.2s");
  });

  it("formatLifecycleEntryComplete: renders sub-second timings", () => {
    expect(
      formatLifecycleEntryComplete({
        phase: "after_up",
        index: 0,
        total: 1,
        exitCode: 0,
        elapsedMs: 42,
      }),
    ).toBe("✓ after_up (1/1) — 0.0s");
  });

  it("pretty mode (non-TTY): lifecycleEntryStart + Complete print plain lines", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.lifecycleEntryStart({
      phase: "before_up",
      index: 0,
      total: 2,
      cmd: "echo first",
    });
    out.lifecycleEntryComplete({
      phase: "before_up",
      index: 0,
      total: 2,
      cmd: "echo first",
      exitCode: 0,
      elapsedMs: 12,
      stderrTail: "",
    });
    out.lifecycleEntryStart({
      phase: "before_up",
      index: 1,
      total: 2,
      cmd: "echo second",
    });
    out.lifecycleEntryComplete({
      phase: "before_up",
      index: 1,
      total: 2,
      cmd: "echo second",
      exitCode: 0,
      elapsedMs: 8,
      stderrTail: "",
    });
    await out.close();

    expect(sink.lines()).toEqual([
      "▶ before_up (1/2): echo first",
      "✓ before_up (1/2) — 0.0s",
      "▶ before_up (2/2): echo second",
      "✓ before_up (2/2) — 0.0s",
    ]);
  });

  it("pretty mode (non-TTY): stderr tail surfaces inline alongside the complete line", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.lifecycleEntryComplete({
      phase: "before_up",
      index: 0,
      total: 1,
      cmd: "( echo boom 1>&2; exit 1 ) || true",
      exitCode: 0,
      elapsedMs: 5,
      stderrTail: "boom\n",
    });
    await out.close();

    expect(sink.lines()).toEqual([
      "✓ before_up (1/1) — 0.0s",
      "▶ before_up (1/1): ( echo boom 1>&2; exit 1 ) || true — stderr: boom",
    ]);
  });

  it("pretty mode (non-TTY): no stderr line when tail is empty", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "pretty", stream: sink });
    out.lifecycleEntryComplete({
      phase: "after_up",
      index: 0,
      total: 1,
      cmd: "true",
      exitCode: 0,
      elapsedMs: 3,
      stderrTail: "",
    });
    await out.close();
    expect(sink.lines()).toEqual(["✓ after_up (1/1) — 0.0s"]);
  });
});
