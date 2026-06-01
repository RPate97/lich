import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runDown } from "../../../src/commands/down.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import { release } from "../../../src/ports/allocator.js";
import * as executorMod from "../../../src/stack/executor.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let stackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-down-exec-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-down-exec-"));
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

describe("runDown — executor dispatch", () => {
  it("dispatches through pickExecutor.down (not maybeRouteToSandbox)", async () => {
    writeFileSync(join(projectDir, "lich.yaml"), 'version: "1"\nowned:\n  s:\n    cmd: "true"\n');
    const wt = detectWorktree(projectDir);
    await writeSnapshot({
      stack_id: wt.stack_id,
      worktree_name: wt.name,
      worktree_path: wt.path,
      status: "up",
      started_at: new Date().toISOString(),
      services: [{ name: "s", kind: "owned", state: "stopped", pid: 2_147_483_640 } as any],
    });
    stackIds.push(wt.stack_id);

    const fakeExecutor = {
      up: vi.fn(async () => ({ exitCode: 0 })),
      down: vi.fn(async () => ({ exitCode: 0, warnings: [] })),
      exec: vi.fn(async () => ({ exitCode: 0 })),
      logs: vi.fn(),
    };
    const spy = vi.spyOn(executorMod, "pickExecutor").mockReturnValue(fakeExecutor as any);

    const out = new PassThrough();
    out.on("data", () => {});
    const result = await runDown({ cwd: projectDir, out, purge: true });

    expect(result.exitCode).toBe(0);
    expect(spy).toHaveBeenCalled();
    expect(fakeExecutor.down).toHaveBeenCalledTimes(1);
    expect((fakeExecutor.down.mock.calls as any)[0]![0]).toMatchObject({ purge: true });

    spy.mockRestore();
  });
});
