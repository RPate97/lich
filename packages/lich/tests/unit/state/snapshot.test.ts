import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import {
  type StackSnapshot,
  readSnapshot,
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
