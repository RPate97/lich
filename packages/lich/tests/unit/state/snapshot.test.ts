import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import {
  type StackSnapshot,
  readSnapshot,
  rebuildAllocatedPorts,
  writeSnapshot,
} from "../../../src/state/snapshot.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-test-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

function sampleSnapshot(stackId = "s1"): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "main",
    worktree_path: "/tmp/some-worktree",
    status: "up",
    started_at: "2026-05-23T10:00:00.000Z",
    services: [
      {
        name: "postgres",
        kind: "compose",
        state: "ready",
        allocated_ports: { POSTGRES_HOST_PORT: 54321 },
        started_at: "2026-05-23T10:00:01.000Z",
      },
      {
        name: "api",
        kind: "owned",
        state: "ready",
        allocated_ports: { PORT: 4000 },
        started_at: "2026-05-23T10:00:02.000Z",
        pid: 12345,
      },
    ],
  };
}

describe("readSnapshot", () => {
  it("returns null when state.json does not exist", async () => {
    expect(await readSnapshot("missing")).toBeNull();
  });

  it("returns null when the stack directory itself does not exist", async () => {
    expect(await readSnapshot("never-existed")).toBeNull();
  });
});

describe("writeSnapshot + readSnapshot round-trip", () => {
  it("writes a snapshot and reads back an equal object", async () => {
    const snap = sampleSnapshot();
    await writeSnapshot(snap);
    const got = await readSnapshot("s1");
    expect(got).toEqual(snap);
  });

  it("creates the stack directory on write if it does not exist", async () => {
    await writeSnapshot(sampleSnapshot("fresh"));
    const got = await readSnapshot("fresh");
    expect(got?.stack_id).toBe("fresh");
  });

  it("overwrites prior snapshot content on subsequent writes", async () => {
    await writeSnapshot(sampleSnapshot());

    const updated: StackSnapshot = {
      ...sampleSnapshot(),
      status: "stopped",
      services: [],
    };
    await writeSnapshot(updated);

    const got = await readSnapshot("s1");
    expect(got?.status).toBe("stopped");
    expect(got?.services).toEqual([]);
  });
});

describe("StackSnapshot active_profile", () => {
  it("writeSnapshot + readSnapshot round-trips active_profile when set", async () => {
    const snap: StackSnapshot = {
      ...sampleSnapshot("ap-set"),
      active_profile: "dev",
    };
    await writeSnapshot(snap);

    const got = await readSnapshot("ap-set");
    expect(got).not.toBeNull();
    expect(got!.active_profile).toBe("dev");
    expect(got).toEqual(snap);
  });

  it("writeSnapshot + readSnapshot omits active_profile when unset", async () => {
    const snap = sampleSnapshot("ap-unset");
    expect(snap.active_profile).toBeUndefined();

    await writeSnapshot(snap);

    // Verify the on-disk JSON has no active_profile key — undefined must
    // not serialize as `"active_profile": null` or any other artifact.
    const raw = readFileSync(join(stackDir("ap-unset"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty("active_profile");

    // And the readback object also lacks the field.
    const got = await readSnapshot("ap-unset");
    expect(got).not.toBeNull();
    expect(got!.active_profile).toBeUndefined();
  });

  it("readSnapshot tolerates an old snapshot that lacks active_profile", async () => {
    // Simulate a state.json written by lich pre-Plan-3 — no active_profile
    // key anywhere in the document.
    const stackId = "ap-legacy";
    const dir = stackDir(stackId);
    await mkdir(dir, { recursive: true });
    const legacy = {
      stack_id: stackId,
      worktree_name: "main",
      worktree_path: "/tmp/legacy",
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
          started_at: "2026-05-23T10:00:01.000Z",
        },
      ],
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2), "utf8");

    const got = await readSnapshot(stackId);
    expect(got).not.toBeNull();
    expect(got!.stack_id).toBe(stackId);
    expect(got!.active_profile).toBeUndefined();
    // Verify the rest of the snapshot parsed correctly so we know the
    // missing field didn't cascade into other problems.
    expect(got!.services).toHaveLength(1);
    expect(got!.services[0].name).toBe("postgres");
  });
});

describe("atomic write", () => {
  it("leaves no .tmp file behind after a successful write", async () => {
    await writeSnapshot(sampleSnapshot());
    const entries = readdirSync(stackDir("s1"));
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
    expect(entries).toContain("state.json");
  });

  it("does not corrupt the destination when serialization throws", async () => {
    // First, lay down a valid snapshot.
    await writeSnapshot(sampleSnapshot());
    const before = await readSnapshot("s1");
    expect(before).not.toBeNull();

    // Attempt a write that JSON.stringify cannot serialize (circular ref).
    const circular: any = { stack_id: "s1" };
    circular.self = circular;

    await expect(writeSnapshot(circular)).rejects.toThrow();

    // Original file is unchanged.
    const after = await readSnapshot("s1");
    expect(after).toEqual(before);

    // No tmp leftover.
    const entries = readdirSync(stackDir("s1"));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

// inverse of up.ts port flattening — down/nuke call this to rebuild structured shape for stop_cmd env
describe("rebuildAllocatedPorts", () => {
  it("reconstructs owned-only single-port allocations under .owned[name].port", () => {
    const snap: StackSnapshot = {
      stack_id: "owned-single-aaa",
      worktree_name: "owned-single",
      worktree_path: "/tmp/owned-single",
      status: "up",
      started_at: "2026-05-24T00:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 4000 },
        },
      ],
    };

    const allocated = rebuildAllocatedPorts(snap);

    expect(allocated.compose).toEqual({});
    expect(allocated.owned).toEqual({
      api: { port: 4000 },
    });
  });

  it("reconstructs compose-only allocations under .compose[name][portKey]", () => {
    const snap: StackSnapshot = {
      stack_id: "compose-only-bbb",
      worktree_name: "compose-only",
      worktree_path: "/tmp/compose-only",
      status: "up",
      started_at: "2026-05-24T00:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          // Compose snapshot stores the inner port map directly.
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
        },
        {
          name: "redis",
          kind: "compose",
          state: "ready",
          allocated_ports: { REDIS_HOST_PORT: 6379, REDIS_METRICS_PORT: 9121 },
        },
      ],
    };

    const allocated = rebuildAllocatedPorts(snap);

    expect(allocated.owned).toEqual({});
    expect(allocated.compose).toEqual({
      postgres: { POSTGRES_HOST_PORT: 54321 },
      redis: { REDIS_HOST_PORT: 6379, REDIS_METRICS_PORT: 9121 },
    });
  });

  it("handles a mixed stack with owned multi-port + compose + a port-less service", () => {
    const snap: StackSnapshot = {
      stack_id: "mixed-ccc",
      worktree_name: "mixed",
      worktree_path: "/tmp/mixed",
      status: "up",
      started_at: "2026-05-24T00:00:00.000Z",
      services: [
        // Owned single-port (only `default`).
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 4000 },
        },
        // Owned multi-port (no `default`).
        {
          name: "edge",
          kind: "owned",
          state: "ready",
          allocated_ports: { http: 8080, grpc: 50051 },
        },
        // Compose with one port.
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
        },
        // Owned with no ports at all — must be omitted from the result.
        {
          name: "worker",
          kind: "owned",
          state: "ready",
        },
        // Compose with an empty port map — also omitted.
        {
          name: "static",
          kind: "compose",
          state: "ready",
          allocated_ports: {},
        },
      ],
    };

    const allocated = rebuildAllocatedPorts(snap);

    expect(allocated.compose).toEqual({
      postgres: { POSTGRES_HOST_PORT: 54321 },
    });
    expect(allocated.owned).toEqual({
      api: { port: 4000 },
      edge: { ports: { http: 8080, grpc: 50051 } },
    });
    // Port-less services don't appear in either bucket.
    expect(allocated.owned.worker).toBeUndefined();
    expect(allocated.compose.static).toBeUndefined();
  });
});
