import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import { writeSnapshot, readSnapshot } from "../../../src/state/snapshot.js";

describe("StackSnapshot executor + data_source persistence", () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lich-snap-adapter-"));
    prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LICH_HOME;
    else process.env.LICH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a snapshot with executor and data_source", async () => {
    const stackId = "demo-12345678";
    const executor = { kind: "sandbox-tart", vm_name: "lich-run-abc-dev" } as const;
    const data_source = {
      kind: "http",
      base_url: "http://10.0.0.5:3300",
      stack_id: "workspace-c52ddf65",
    } as const;
    await writeSnapshot({
      stack_id: stackId,
      worktree_name: "demo",
      worktree_path: "/work/demo",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [],
      executor,
      data_source,
    });

    const raw = readFileSync(join(stackDir(stackId), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.executor).toEqual(executor);
    expect(parsed.data_source).toEqual(data_source);

    const snap = await readSnapshot(stackId);
    expect(snap?.executor).toEqual(executor);
    expect(snap?.data_source).toEqual(data_source);
  });

  it("absent fields stay undefined on read (backward compat)", async () => {
    await writeSnapshot({
      stack_id: "demo-no-adapter",
      worktree_name: "demo",
      worktree_path: "/work/demo",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [],
    });
    const snap = await readSnapshot("demo-no-adapter");
    expect(snap?.executor).toBeUndefined();
    expect(snap?.data_source).toBeUndefined();
  });
});
