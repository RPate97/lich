import { describe, test, expect } from "vitest";
import { CopySync } from "../../../src/sandbox/copy-sync.js";
import type { PipeExec } from "../../../src/sandbox/copy-sync.js";

class FakePipeExec implements PipeExec {
  calls: Array<{
    producer: { cmd: string; args: string[]; cwd: string };
    consumer: { cmd: string; args: string[] };
  }> = [];
  async run(
    producer: { cmd: string; args: string[]; cwd: string },
    consumer: { cmd: string; args: string[] },
  ): Promise<void> {
    this.calls.push({ producer, consumer });
  }
}

const opts = (over: Record<string, unknown> = {}) => ({
  name: "lich-run-abc",
  hostPath: "/work/tree",
  target: "10.0.0.5",
  guestPath: "/workspace",
  ignore: ["dist"],
  ...over,
});

describe("CopySync", () => {
  test("start tars host worktree excluding node_modules, pipes into guest", async () => {
    const pipe = new FakePipeExec();
    await new CopySync(pipe).start(opts());
    expect(pipe.calls).toHaveLength(1);
    const { producer, consumer } = pipe.calls[0]!;
    expect(producer.cmd).toBe("tar");
    expect(producer.cwd).toBe("/work/tree");
    expect(producer.args).toContain("--exclude=node_modules");
    expect(producer.args).toContain("--exclude=.git");
    expect(producer.args).toContain("--exclude=dist");
    expect(consumer.cmd).toBe("tart");
    expect(consumer.args.slice(0, 3)).toEqual(["exec", "-i", "lich-run-abc"]);
    expect(consumer.args).toContain("/workspace");
  });

  test("node_modules excluded even when caller passes ignore: []", async () => {
    const pipe = new FakePipeExec();
    await new CopySync(pipe).start(opts({ ignore: [] }));
    expect(pipe.calls[0]!.producer.args).toContain("--exclude=node_modules");
  });

  test("flush re-copies (one-shot, no live watch)", async () => {
    const pipe = new FakePipeExec();
    const s = new CopySync(pipe);
    await s.start(opts());
    await s.flush("lich-run-abc");
    expect(pipe.calls).toHaveLength(2);
  });

  test("flush on an unknown session is a no-op", async () => {
    const pipe = new FakePipeExec();
    await new CopySync(pipe).flush("never-started");
    expect(pipe.calls).toHaveLength(0);
  });

  test("terminate is a no-op (no extra VM call)", async () => {
    const pipe = new FakePipeExec();
    const s = new CopySync(pipe);
    await s.start(opts());
    await expect(s.terminate("lich-run-abc")).resolves.toBeUndefined();
    expect(pipe.calls).toHaveLength(1);
  });
});
