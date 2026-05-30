import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stackDir } from "../../../src/state/directory.js";
import {
  LIFECYCLE_FAILED_CMD_MAX,
  readSnapshot,
  truncateFailedCmd,
  writeSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-lifecycle-status-"));
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

function baseSnapshot(stackId: string): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "main",
    worktree_path: "/tmp/work",
    status: "up",
    started_at: "2026-05-29T10:00:00.000Z",
    services: [],
  };
}

describe("StackSnapshot.lifecycle field — round-trip", () => {
  it("persists `ok` status for each phase that ran cleanly", async () => {
    const snap = baseSnapshot("s-clean");
    snap.lifecycle = {
      before_up: { status: "ok" },
      after_up: { status: "ok" },
    };
    await writeSnapshot(snap);

    const got = await readSnapshot("s-clean");
    expect(got).not.toBeNull();
    expect(got!.lifecycle).toEqual({
      before_up: { status: "ok" },
      after_up: { status: "ok" },
    });
  });

  it("persists `failed` status with index/cmd/log_path", async () => {
    const snap = baseSnapshot("s-failed");
    snap.status = "failed";
    snap.lifecycle = {
      before_up: { status: "ok" },
      after_up: {
        status: "failed",
        failed_index: 1,
        total: 3,
        failed_cmd: "pnpm db:reset",
        log_path: "/home/.lich/stacks/s-failed/logs/after_up.log",
      },
    };
    await writeSnapshot(snap);

    const raw = readFileSync(join(stackDir("s-failed"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.lifecycle.before_up).toEqual({ status: "ok" });
    expect(parsed.lifecycle.after_up).toEqual({
      status: "failed",
      failed_index: 1,
      total: 3,
      failed_cmd: "pnpm db:reset",
      log_path: "/home/.lich/stacks/s-failed/logs/after_up.log",
    });

    const got = await readSnapshot("s-failed");
    expect(got!.lifecycle).toEqual(snap.lifecycle);
  });

  it("omits lifecycle field on snapshots that never set it (pre-LEV-531 shape)", async () => {
    const snap = baseSnapshot("s-no-lifecycle");
    await writeSnapshot(snap);

    const raw = readFileSync(join(stackDir("s-no-lifecycle"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect("lifecycle" in parsed).toBe(false);

    const got = await readSnapshot("s-no-lifecycle");
    expect(got!.lifecycle).toBeUndefined();
  });

  it("supports `not_run` for phases that did not execute", async () => {
    const snap = baseSnapshot("s-not-run");
    snap.lifecycle = {
      before_up: { status: "ok" },
      after_up: { status: "not_run" },
    };
    await writeSnapshot(snap);
    const got = await readSnapshot("s-not-run");
    expect(got!.lifecycle?.after_up).toEqual({ status: "not_run" });
  });
});

describe("truncateFailedCmd", () => {
  it("returns the cmd unchanged when shorter than the cap", () => {
    expect(truncateFailedCmd("echo hi")).toBe("echo hi");
  });

  it("appends `...` when over the cap", () => {
    const long = "a".repeat(LIFECYCLE_FAILED_CMD_MAX + 50);
    const out = truncateFailedCmd(long);
    expect(out.length).toBe(LIFECYCLE_FAILED_CMD_MAX + 3);
    expect(out.endsWith("...")).toBe(true);
  });

  it("handles exactly-at-cap input without truncation", () => {
    const exact = "x".repeat(LIFECYCLE_FAILED_CMD_MAX);
    expect(truncateFailedCmd(exact)).toBe(exact);
  });
});
