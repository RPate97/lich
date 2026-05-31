import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await writeSnapshot({
      stack_id: "demo-12345678",
      worktree_name: "demo",
      worktree_path: "/work/demo",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [],
      executor: { kind: "sandbox-tart", vm_name: "lich-run-abc-dev" },
      data_source: {
        kind: "http",
        base_url: "http://10.0.0.5:3300",
        stack_id: "workspace-c52ddf65",
      },
    });
    const snap = await readSnapshot("demo-12345678");
    expect(snap?.executor).toEqual({ kind: "sandbox-tart", vm_name: "lich-run-abc-dev" });
    expect(snap?.data_source).toEqual({
      kind: "http",
      base_url: "http://10.0.0.5:3300",
      stack_id: "workspace-c52ddf65",
    });
  });
});
