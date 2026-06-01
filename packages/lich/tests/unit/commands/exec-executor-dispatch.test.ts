import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec } from "../../../src/commands/exec.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import { release } from "../../../src/ports/allocator.js";
import * as executorMod from "../../../src/stack/executor.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let stackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-exec-exec-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-exec-exec-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  stackIds = [];
});

afterEach(async () => {
  for (const id of stackIds) await release(id).catch(() => {});
  if (prevHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("runExec — executor dispatch", () => {
  it("dispatches through pickExecutor.exec (not maybeRouteToSandbox)", async () => {
    writeFileSync(join(projectDir, "lich.yaml"), 'version: "1"\nowned:\n  s:\n    cmd: "true"\n');
    const wt = detectWorktree(projectDir);
    await writeSnapshot({
      stack_id: wt.stack_id,
      worktree_name: wt.name,
      worktree_path: wt.path,
      status: "up",
      started_at: new Date().toISOString(),
      services: [{ name: "s", kind: "owned", state: "healthy" } as any],
    });
    stackIds.push(wt.stack_id);

    const fakeExecutor = {
      up: vi.fn(async () => ({ exitCode: 0 })),
      down: vi.fn(async () => ({ exitCode: 0, warnings: [] })),
      exec: vi.fn(async () => ({ exitCode: 0 })),
      logs: vi.fn(),
    };
    const spy = vi.spyOn(executorMod, "pickExecutor").mockReturnValue(fakeExecutor as any);

    const result = await runExec({ cwd: projectDir, argv: ["echo", "hello"] });

    expect(result.exitCode).toBe(0);
    expect(spy).toHaveBeenCalled();
    expect(fakeExecutor.exec).toHaveBeenCalledTimes(1);
    expect((fakeExecutor.exec.mock.calls as any)[0]![0]).toMatchObject({ argv: ["echo", "hello"] });

    spy.mockRestore();
  });
});
