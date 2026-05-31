import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { _runtimeFactory } from "../../../src/sandbox/command-routing.js";

// Regression: `lich down --purge` should clean up an orphaned sandbox VM
// even when the cwd has no lich.yaml AND the snapshot is "stopped" — the
// recovery flow after a reboot wipes /tmp/lich-demo. The host snapshot
// persists in ~/.lich and the VM persists in Tart, but the project dir
// and its yaml are gone.

class FakeSandboxRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async down(...args: unknown[]) { this.calls.push({ method: "down", args }); }
  async exec(...args: unknown[]) {
    this.calls.push({ method: "exec", args });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let prevFactory: (typeof _runtimeFactory)["current"];
let fakeRuntime: FakeSandboxRuntime;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-orphan-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "lich-orphan-proj-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];

  fakeRuntime = new FakeSandboxRuntime();
  prevFactory = _runtimeFactory.current;
  _runtimeFactory.current = (() =>
    fakeRuntime as unknown as ReturnType<typeof _runtimeFactory.current>) as typeof _runtimeFactory.current;
});

afterEach(async () => {
  for (const id of createdStackIds) await release(id).catch(() => {});
  if (prevHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  _runtimeFactory.current = prevFactory;
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
  it("routes to SandboxRuntime.down({purge:true}) even with no lich.yaml AND status:stopped", async () => {
    await seedSandboxStoppedSnapshot();
    const out = new PassThrough();
    out.on("data", () => {});
    const result = await runDown({ cwd: projectDir, out, purge: true });

    expect(result.exitCode).toBe(0);
    const downCalls = fakeRuntime.calls.filter((c) => c.method === "down");
    expect(downCalls).toHaveLength(1);
    const [, opts] = downCalls[0]!.args as [unknown, unknown];
    expect(opts).toEqual({ purge: true });
  });
});
