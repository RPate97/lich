import { describe, it, expect } from "vitest";
import { pickExecutor } from "../../../src/stack/executor.js";
import { LocalStackExecutor } from "../../../src/stack/executors/local.js";
import { SandboxStackExecutor } from "../../../src/stack/executors/sandbox-tart.js";
import type { StackSnapshot } from "../../../src/state/snapshot.js";

const baseSnap = (over: Partial<StackSnapshot>): StackSnapshot => ({
  stack_id: "x",
  worktree_name: "x",
  worktree_path: "/x",
  status: "up",
  started_at: "t",
  services: [],
  ...over,
});

describe("pickExecutor", () => {
  it("returns LocalStackExecutor for snapshot with no executor field", () => {
    const exe = pickExecutor(baseSnap({}), { lichYamlPath: "/x/lich.yaml", worktree: { id: "wt1", name: "x", path: "/x", stack_id: "x" } as any });
    expect(exe).toBeInstanceOf(LocalStackExecutor);
  });

  it("returns LocalStackExecutor when executor.kind === 'local'", () => {
    const exe = pickExecutor(baseSnap({ executor: { kind: "local" } }), { lichYamlPath: "/x/lich.yaml", worktree: { id: "wt1", name: "x", path: "/x", stack_id: "x" } as any });
    expect(exe).toBeInstanceOf(LocalStackExecutor);
  });

  it("returns SandboxStackExecutor when executor.kind === 'sandbox-tart'", () => {
    const exe = pickExecutor(
      baseSnap({ executor: { kind: "sandbox-tart", vm_name: "lich-run-abc" }, active_profile: "dev" }),
      { lichYamlPath: "/x/lich.yaml", worktree: { id: "wt1", name: "x", path: "/x", stack_id: "x" } as any },
    );
    expect(exe).toBeInstanceOf(SandboxStackExecutor);
  });

  it("legacy: treats snap.sandbox === true (without executor) as sandbox-tart", () => {
    const exe = pickExecutor(
      baseSnap({ sandbox: true, sandbox_vm: "lich-run-old", active_profile: "dev" }),
      { lichYamlPath: "/x/lich.yaml", worktree: { id: "wt1", name: "x", path: "/x", stack_id: "x" } as any },
    );
    expect(exe).toBeInstanceOf(SandboxStackExecutor);
  });

  it("throws on unknown kind", () => {
    expect(() => pickExecutor(
      baseSnap({ executor: { kind: "alien" as any } } as any),
      { lichYamlPath: "/x/lich.yaml", worktree: { id: "wt1", name: "x", path: "/x", stack_id: "x" } as any },
    )).toThrow(/unknown executor kind/i);
  });
});
