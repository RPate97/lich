import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const SANDBOX_YAML = `version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs:
      - "db/migrations/**"
      - "db/seed.sql"
owned:
  api:
    cmd: "echo hi"
    cwd: "."
profiles:
  dev:
    default: true
    owned: [api]
`;

describe("pickExecutor", () => {
  let dir: string;
  let yamlPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lich-pick-exec-"));
    yamlPath = join(dir, "lich.yaml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = () => ({
    lichYamlPath: yamlPath,
    worktree: { id: "wt1", name: "x", path: dir, stack_id: "x" } as any,
  });

  it("returns LocalStackExecutor for snapshot with no executor field", async () => {
    // Local path doesn't read the yaml, so the file doesn't need to exist.
    const exe = await pickExecutor(baseSnap({}), deps());
    expect(exe).toBeInstanceOf(LocalStackExecutor);
  });

  it("returns LocalStackExecutor when executor.kind === 'local'", async () => {
    const exe = await pickExecutor(baseSnap({ executor: { kind: "local" } }), deps());
    expect(exe).toBeInstanceOf(LocalStackExecutor);
  });

  it("returns SandboxStackExecutor when executor.kind === 'sandbox-tart'", async () => {
    writeFileSync(yamlPath, SANDBOX_YAML);
    const exe = await pickExecutor(
      baseSnap({ executor: { kind: "sandbox-tart", vm_name: "lich-run-abc" }, active_profile: "dev" }),
      deps(),
    );
    expect(exe).toBeInstanceOf(SandboxStackExecutor);
  });

  it("legacy: treats snap.sandbox === true (without executor) as sandbox-tart", async () => {
    writeFileSync(yamlPath, SANDBOX_YAML);
    const exe = await pickExecutor(
      baseSnap({ sandbox: true, sandbox_vm: "lich-run-old", active_profile: "dev" }),
      deps(),
    );
    expect(exe).toBeInstanceOf(SandboxStackExecutor);
  });

  it("throws on unknown kind", async () => {
    await expect(pickExecutor(
      baseSnap({ executor: { kind: "alien" as any } } as any),
      deps(),
    )).rejects.toThrow(/unknown executor kind/i);
  });

  it("throws when sandbox-tart executor is selected but lich.yaml fails to parse", async () => {
    // YAML syntax error: unclosed flow map.
    writeFileSync(yamlPath, "{ unbalanced:");
    await expect(pickExecutor(
      baseSnap({ executor: { kind: "sandbox-tart", vm_name: "lich-run-x" }, active_profile: "dev" }),
      deps(),
    )).rejects.toThrow(/failed to parse/);
  });

  it("throws when sandbox-tart executor is selected but yaml has no runtime.sandbox", async () => {
    writeFileSync(yamlPath, `version: "1"
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  dev:
    default: true
    owned: [api]
`);
    await expect(pickExecutor(
      baseSnap({ executor: { kind: "sandbox-tart", vm_name: "lich-run-x" }, active_profile: "dev" }),
      deps(),
    )).rejects.toThrow(/no runtime\.sandbox block/);
  });
});
