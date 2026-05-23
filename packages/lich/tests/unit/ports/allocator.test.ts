import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocate,
  release,
  listAllocations,
} from "../../../src/ports/allocator.js";

let lichHome: string;
let prevLichHome: string | undefined;

beforeEach(async () => {
  lichHome = await mkdtemp(join(tmpdir(), "lich-alloc-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = lichHome;
});

afterEach(async () => {
  if (prevLichHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevLichHome;
  await rm(lichHome, { recursive: true, force: true });
});

/**
 * Pick a range that doesn't collide with common dev-machine listeners
 * (5432 postgres, 6379 redis, 3000 next, etc.). 50000+ ephemeral-ish.
 * Each test uses its own subrange so a leaked allocation in one test
 * doesn't poison another (we reset LICH_HOME anyway, but defense in
 * depth).
 */
const RANGE_A: [number, number] = [54100, 54199];
const RANGE_B: [number, number] = [54200, 54299];

describe("allocate", () => {
  it("allocates ports for every logical name and returns a complete map", async () => {
    const result = await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null, api: null, db: null },
      range: RANGE_A,
    });
    expect(Object.keys(result).sort()).toEqual(["api", "db", "web"]);
    for (const p of Object.values(result)) {
      expect(p).toBeGreaterThanOrEqual(RANGE_A[0]);
      expect(p).toBeLessThanOrEqual(RANGE_A[1]);
    }
    // All ports distinct.
    const set = new Set(Object.values(result));
    expect(set.size).toBe(3);
  });

  it("persists allocations to the registry file", async () => {
    await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null },
      range: RANGE_A,
    });
    const raw = await readFile(join(lichHome, "ports.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.allocations["stack-1"]).toBeDefined();
    expect(typeof parsed.allocations["stack-1"].web).toBe("number");
  });

  it("is idempotent: re-calling for the same stackId returns the same map", async () => {
    const first = await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null, api: null },
      range: RANGE_A,
    });
    const second = await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null, api: null },
      range: RANGE_A,
    });
    expect(second).toEqual(first);
  });

  it("two stacks allocating from the same range in parallel get different ports", async () => {
    const [a, b] = await Promise.all([
      allocate({
        stackId: "stack-A",
        logicalPorts: { web: null, api: null },
        range: RANGE_A,
      }),
      allocate({
        stackId: "stack-B",
        logicalPorts: { web: null, api: null },
        range: RANGE_A,
      }),
    ]);
    expect(a.web).not.toBe(b.web);
    expect(a.api).not.toBe(b.api);
    // Cross-check: no port from A appears in B's allocations.
    const aPorts = new Set(Object.values(a));
    for (const p of Object.values(b)) {
      expect(aPorts.has(p)).toBe(false);
    }
  });

  it("honors a pinned port when free", async () => {
    const result = await allocate({
      stackId: "stack-1",
      logicalPorts: { db: 54155, web: null },
      range: RANGE_A,
    });
    expect(result.db).toBe(54155);
    expect(result.web).not.toBe(54155);
  });

  it("throws naming the conflicting stack when a pinned port is held by another stack", async () => {
    await allocate({
      stackId: "stack-A",
      logicalPorts: { db: 54160 },
      range: RANGE_A,
    });
    await expect(
      allocate({
        stackId: "stack-B",
        logicalPorts: { db: 54160 },
        range: RANGE_A,
      }),
    ).rejects.toThrow(/stack-A/);
  });

  it("release removes the stack from the registry", async () => {
    await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null },
      range: RANGE_A,
    });
    await release("stack-1");
    const all = await listAllocations();
    expect(all["stack-1"]).toBeUndefined();
  });

  it("release is idempotent (no-op for unknown stack)", async () => {
    await expect(release("never-existed")).resolves.toBeUndefined();
  });

  it("a different stack can reuse ports after release", async () => {
    const first = await allocate({
      stackId: "stack-A",
      logicalPorts: { web: null, api: null },
      range: RANGE_A,
    });
    await release("stack-A");
    const second = await allocate({
      stackId: "stack-B",
      logicalPorts: { web: null, api: null },
      range: RANGE_A,
    });
    // After release, the new stack should be able to claim the same
    // low-numbered ports (we pick lowest-free first).
    expect(second.web).toBe(first.web);
    expect(second.api).toBe(first.api);
  });

  it("listAllocations returns every stack's port map", async () => {
    await allocate({
      stackId: "stack-A",
      logicalPorts: { web: null },
      range: RANGE_A,
    });
    await allocate({
      stackId: "stack-B",
      logicalPorts: { api: null },
      range: RANGE_B,
    });
    const all = await listAllocations();
    expect(Object.keys(all).sort()).toEqual(["stack-A", "stack-B"]);
    expect(all["stack-A"].web).toBeDefined();
    expect(all["stack-B"].api).toBeDefined();
  });

  it("listAllocations returns a defensive copy (mutation does not affect registry)", async () => {
    await allocate({
      stackId: "stack-1",
      logicalPorts: { web: null },
      range: RANGE_A,
    });
    const first = await listAllocations();
    delete first["stack-1"];
    const second = await listAllocations();
    expect(second["stack-1"]).toBeDefined();
  });

  it("throws when the range has no free ports", async () => {
    // Single-port range, immediately exhausted by a different stack.
    const tinyRange: [number, number] = [54300, 54300];
    await allocate({
      stackId: "stack-A",
      logicalPorts: { web: null },
      range: tinyRange,
    });
    await expect(
      allocate({
        stackId: "stack-B",
        logicalPorts: { web: null },
        range: tinyRange,
      }),
    ).rejects.toThrow(/no free ports/);
  });
});
