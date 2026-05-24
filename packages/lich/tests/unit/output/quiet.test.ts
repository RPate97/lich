import { describe, expect, it } from "vitest";
import { createOutput } from "../../../src/output/index.js";
import { makeSink } from "./helpers.js";

describe("quiet output", () => {
  it("suppresses phase begin/step/end output", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    const p = out.phase("allocating ports");
    p.step("allocating port for api");
    p.end("ok");
    await out.close();

    expect(sink.text).toBe("");
  });

  it("suppresses info lines", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    out.info("stack id: dogfood-stack");
    await out.close();

    expect(sink.text).toBe("");
  });

  it("suppresses service status updates", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    out.service("api", "starting");
    out.service("api", "ready");
    await out.close();

    expect(sink.text).toBe("");
  });

  it("still emits the summary block", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    out.summary({
      title: "stack up",
      lines: ["worktree: ~/foo"],
      services: [{ name: "api", state: "ready" }],
    });
    await out.close();

    // Quiet mode uses the same renderer as pretty (no spinner, no color).
    // See pretty.test.ts for the rationale on the table layout (LEV-301).
    expect(sink.lines()).toEqual([
      "stack up",
      "  worktree: ~/foo",
      "",
      "  services:",
      "    api  ready",
    ]);
  });

  it("still emits the error block", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    out.error({
      title: "failed to start api",
      detail: "exit code 1",
      hint: "check logs",
    });
    await out.close();

    expect(sink.lines()).toEqual([
      "✗ failed to start api",
      "  exit code 1",
      "  hint: check logs",
    ]);
  });

  it("does not emit ANSI escape codes", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    out.summary({ title: "stack up", lines: [] });
    out.error({ title: "x", detail: "y" });
    await out.close();

    expect(sink.text).not.toContain("\x1b");
  });

  it("a quiet phase handle is safe to call repeatedly", async () => {
    const sink = makeSink();
    const out = createOutput({ mode: "quiet", stream: sink });
    const p = out.phase("x");
    p.step("a");
    p.step("b");
    p.end("ok");
    p.end("fail"); // calling end twice should not throw
    await out.close();

    expect(sink.text).toBe("");
  });
});
