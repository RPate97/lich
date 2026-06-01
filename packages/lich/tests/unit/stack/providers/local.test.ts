import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStackDataProvider } from "../../../../src/stack/providers/local.js";

let stateRoot: string;
beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-local-provider-"));
});
afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function seedSnapshot(id: string, snap: Record<string, unknown>) {
  const dir = join(stateRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(snap));
}

describe("LocalStackDataProvider", () => {
  it("listStacks returns StackView for each on-disk snapshot", async () => {
    seedSnapshot("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/work/feature-x",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    const stacks = await provider.listStacks();
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.id).toBe("stack-1");
    expect(stacks[0]!.services).toHaveLength(1);
  });

  it("loadStack returns a single view by id", async () => {
    seedSnapshot("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/work/feature-x",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [],
    });
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    expect((await provider.loadStack("stack-1"))?.id).toBe("stack-1");
    expect(await provider.loadStack("nonexistent")).toBeNull();
  });

  it("metricsLatest returns sampler.latest result", async () => {
    const fakeSnapshot = {
      stack_id: "stack-1",
      sampled_at: "2026-05-31T00:00:00Z",
      total: { cpu_pct: 5, mem_bytes: 1024 },
      services: [],
    };
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
      metricsSampler: { latest: () => fakeSnapshot as any, subscribe: () => () => {} } as any,
    });
    expect(await provider.metricsLatest("stack-1")).toEqual(fakeSnapshot);
  });

  it("metricsLatest returns null when no sampler configured", async () => {
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    expect(await provider.metricsLatest("stack-1")).toBeNull();
  });

  it("procTree returns null when no psFn and service has no pid", async () => {
    seedSnapshot("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/work/feature-x",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    expect(await provider.procTree("stack-1", "api")).toBeNull();
  });

  it("procTree returns null for compose services", async () => {
    seedSnapshot("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/work/feature-x",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [{ name: "db", kind: "compose", state: "healthy" }],
    });
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    expect(await provider.procTree("stack-1", "db")).toBeNull();
  });

  it("procTree returns null for nonexistent stack", async () => {
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
    });
    expect(await provider.procTree("nonexistent", "api")).toBeNull();
  });

  it("procTree aggregates subtree from psFn when pid is set", async () => {
    seedSnapshot("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/work/feature-x",
      status: "up",
      started_at: "2026-05-31T00:00:00Z",
      services: [{ name: "api", kind: "owned", state: "ready", pid: 100 }],
    });
    const fakeRows = [
      { pid: 100, ppid: 1, rss_kb: 1024, pcpu: 5, cpu_time_seconds: 10 },
      { pid: 101, ppid: 100, rss_kb: 512, pcpu: 2, cpu_time_seconds: 5 },
    ];
    const provider = new LocalStackDataProvider({
      stateRoot,
      proxyPort: 3300,
      tailFactory: () => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any),
      psFn: async () => fakeRows,
    });
    const agg = await provider.procTree("stack-1", "api");
    expect(agg).not.toBeNull();
    expect(agg!.process_count).toBe(2);
    expect(agg!.mem_bytes).toBe((1024 + 512) * 1024);
  });
});
