import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";

import { runDown } from "../../../src/commands/down.js";
import { hashPath, sanitizeName } from "../../../src/worktree/detect.js";
import {
  writeSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { release } from "../../../src/ports/allocator.js";
import * as executorMod from "../../../src/stack/executor.js";

// Regression: `lich down --purge` should clean up an orphaned sandbox VM
// even when the cwd has no lich.yaml AND the snapshot is "stopped" — the
// recovery flow after a reboot wipes /tmp/lich-demo. The host snapshot
// persists in ~/.lich and the VM persists in Tart, but the project dir
// and its yaml are gone.

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-orphan-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "lich-orphan-proj-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) await release(id).catch(() => {});
  if (prevHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function makeWorktreeFor(dir: string) {
  const abs = realpathSync(dir);
  const name = sanitizeName(basename(abs));
  const id = hashPath(abs);
  return { name, id, path: abs, stack_id: `${name}-${id.slice(0, 8)}` };
}

async function seedSandboxStoppedSnapshot(): Promise<string> {
  const wt = makeWorktreeFor(projectDir);
  const snap: StackSnapshot = {
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "stopped",
    started_at: new Date().toISOString(),
    services: [],
    sandbox: true,
    sandbox_vm: "lich-run-orphan-test",
    active_profile: "dev:box",
  };
  await writeSnapshot(snap);
  createdStackIds.push(wt.stack_id);
  return wt.stack_id;
}

describe("lich down --purge — orphaned sandbox stack", () => {
  it("dispatches through pickExecutor.down({purge:true}) even with no lich.yaml AND status:stopped", async () => {
    await seedSandboxStoppedSnapshot();

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
    expect(fakeExecutor.down.mock.calls[0]![0]).toMatchObject({ purge: true });

    spy.mockRestore();
  });
});
