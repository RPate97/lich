import { describe, expect, it } from "vitest";
import { shouldEarlyExitOnStopped } from "../../../src/commands/down.js";
import type { StackSnapshot } from "../../../src/state/snapshot.js";

// Bug regression: `lich down --purge` on a stopped sandbox snapshot must
// reach the sandbox routing block to destroy the VM. The early-exit on
// status==="stopped" used to bail unconditionally, leaving the VM alive.
//
// We test the gate logic in isolation rather than driving runDown, because
// other test files (restart.test.ts) install global vi.mock on commands/down.js
// and bun's mock registry leaks across files, making integration-style tests
// for this exact module non-deterministic.

function makeSnap(over: Partial<StackSnapshot>): StackSnapshot {
  return {
    stack_id: "x-wt1",
    worktree_name: "x",
    worktree_path: "/x",
    status: "up",
    started_at: "2026-05-31T00:00:00Z",
    services: [],
    ...over,
  };
}

describe("shouldEarlyExitOnStopped", () => {
  it("returns false (proceeds) for sandbox + stopped + purge → routing must run", () => {
    const snap = makeSnap({ status: "stopped", sandbox: true });
    expect(shouldEarlyExitOnStopped(snap, true)).toBe(false);
  });

  it("returns true (early-exits) for sandbox + stopped + NO purge", () => {
    const snap = makeSnap({ status: "stopped", sandbox: true });
    expect(shouldEarlyExitOnStopped(snap, false)).toBe(true);
    expect(shouldEarlyExitOnStopped(snap, undefined)).toBe(true);
  });

  it("returns true (early-exits) for non-sandbox + stopped + purge", () => {
    const snap = makeSnap({ status: "stopped" });
    expect(shouldEarlyExitOnStopped(snap, true)).toBe(true);
  });

  it("returns false (proceeds) for any non-stopped status, regardless of purge or sandbox", () => {
    const upSnap = makeSnap({ status: "up", sandbox: true });
    expect(shouldEarlyExitOnStopped(upSnap, true)).toBe(false);
    expect(shouldEarlyExitOnStopped(upSnap, false)).toBe(false);

    const stoppingSnap = makeSnap({ status: "stopping" });
    expect(shouldEarlyExitOnStopped(stoppingSnap, true)).toBe(false);
  });
});
