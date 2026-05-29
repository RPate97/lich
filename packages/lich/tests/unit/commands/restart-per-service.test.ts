import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { runRestart } from "../../../src/commands/restart.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  readSnapshot,
  writeSnapshot,
  type StackSnapshot,
  type ServiceSnapshot,
} from "../../../src/state/snapshot.js";
import { serviceLogPath } from "../../../src/state/directory.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let spawnedPids: number[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-restart-ps-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-restart-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  spawnedPids = [];
  writeFileSync(join(projectDir, "lich.yaml"), 'version: "1"\n', "utf8");
});

afterEach(() => {
  for (const pid of spawnedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function captureOutput(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

async function seedSnapshot(services: ServiceSnapshot[]): Promise<{ stackId: string }> {
  const wt = detectWorktree(projectDir);
  const snap: StackSnapshot = {
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    services,
  };
  await writeSnapshot(snap);
  return { stackId: wt.stack_id };
}

function spawnSleepProcess(): number {
  const child = spawn("sleep", ["9999"], { stdio: "ignore", detached: true });
  if (typeof child.pid !== "number") throw new Error("spawn failed");
  child.unref();
  spawnedPids.push(child.pid);
  return child.pid;
}

function makeLogDir(stackId: string, name: string): string {
  const logPath = serviceLogPath(stackId, name);
  mkdirSync(dirname(logPath), { recursive: true });
  return logPath;
}

describe("runRestart — per-service: no stack running", () => {
  it("exits 1 and prints 'no running stack found'", async () => {
    const { stream, text } = captureOutput();
    const result = await runRestart({ cwd: projectDir, out: stream, outputMode: "quiet", services: ["web"] });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("no running stack found");
  });
});

describe("runRestart — per-service: service not found", () => {
  it("exits 1 and names the unknown service", async () => {
    await seedSnapshot([{ name: "api", kind: "owned", state: "ready" }]);
    const { stream, text } = captureOutput();
    const result = await runRestart({ cwd: projectDir, out: stream, outputMode: "quiet", services: ["ghost"] });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("ghost");
  });
});

describe("runRestart — per-service: compose service rejected", () => {
  it("exits 1 and mentions 'compose'", async () => {
    await seedSnapshot([{ name: "postgres", kind: "compose", state: "ready" }]);
    const { stream, text } = captureOutput();
    const result = await runRestart({ cwd: projectDir, out: stream, outputMode: "quiet", services: ["postgres"] });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("compose");
  });
});

describe("runRestart — per-service: missing snapshot data", () => {
  it("exits 1 when cmd/resolved_env absent (legacy snapshot)", async () => {
    await seedSnapshot([{ name: "api", kind: "owned", state: "ready" }]);
    const { stream, text } = captureOutput();
    const result = await runRestart({ cwd: projectDir, out: stream, outputMode: "quiet", services: ["api"] });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("snapshot data");
  });
});

describe("runRestart — per-service: happy path", () => {
  it("stops old process, starts new one, updates pid in state.json, sibling untouched", async () => {
    const wt = detectWorktree(projectDir);
    const { stackId } = await seedSnapshot([]);

    const apiLogPath = makeLogDir(stackId, "api");
    const webLogPath = makeLogDir(stackId, "web");

    const oldApiPid = spawnSleepProcess();
    const webPid = spawnSleepProcess();

    await seedSnapshot([
      {
        name: "api",
        kind: "owned",
        state: "ready",
        pid: oldApiPid,
        cmd: "sleep 9999",
        resolved_env: { PATH: process.env.PATH ?? "/usr/bin" },
        service_cwd: projectDir,
        allocated_ports: {},
      },
      {
        name: "web",
        kind: "owned",
        state: "ready",
        pid: webPid,
        cmd: "sleep 9999",
        resolved_env: { PATH: process.env.PATH ?? "/usr/bin" },
        service_cwd: projectDir,
        allocated_ports: {},
      },
    ]);

    const { stream } = captureOutput();
    const result = await runRestart({
      cwd: projectDir,
      out: stream,
      outputMode: "quiet",
      services: ["api"],
    });

    expect(result.exitCode).toBe(0);

    // Old api process killed.
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(oldApiPid)).toBe(false);

    // web sibling untouched.
    expect(isAlive(webPid)).toBe(true);

    // State updated: api pid changed, web pid unchanged.
    const snap = await readSnapshot(stackId);
    expect(snap).not.toBeNull();
    const apiSnap = snap!.services.find((s) => s.name === "api");
    const webSnap = snap!.services.find((s) => s.name === "web");
    expect(apiSnap?.state).toBe("ready");
    expect(apiSnap?.pid).not.toBe(oldApiPid);
    expect(webSnap?.pid).toBe(webPid);

    // Kill the newly spawned api process.
    if (typeof apiSnap?.pid === "number") {
      spawnedPids.push(apiSnap.pid);
    }
  }, 30_000);
});

describe("runRestart — --all flag is whole-stack (no per-service path)", () => {
  it("['--all'] with running stack still triggers down+up (not per-service)", async () => {
    const { stream, text } = captureOutput();
    const result = await runRestart({
      cwd: projectDir,
      out: stream,
      outputMode: "quiet",
      services: ["--all"],
    });
    // Down will return 0 (nothing to stop), up will fail (no config with profiles).
    // Key assertion: it did NOT enter the per-service path (which would say "no running stack found").
    expect(text()).not.toContain("no running stack found");
  });
});
