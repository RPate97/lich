import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import {
  readSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { listAllocations, release } from "../../../src/ports/allocator.js";

const packageRoot = resolve(__dirname, "../../..");
const lichBinary = resolve(packageRoot, "dist/lich");

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let childToReap: ChildProcess | null = null;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-sigint-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  childToReap = null;
});

afterEach(async () => {
  // SIGKILL any spawned binary that escaped the test (assertion failed before SIGINT)
  if (childToReap && childToReap.pid && !childToReap.killed) {
    try {
      process.kill(childToReap.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  childToReap = null;

  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

async function loadSnapshot(stackId: string): Promise<StackSnapshot | null> {
  return readSnapshot(stackId);
}

describe("runUp — SIGINT/AbortSignal cancellation contract", () => {
  it("aborts the in-flight tcp ready wait and marks the stack failed within 2s", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19550]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(elapsedMs).toBeLessThan(1500);
    expect(result.exitCode).toBe(1);

    const snap = await loadSnapshot(result.stackId!);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("failed");
  }, 10_000);

  it("releases allocated ports when cancelled mid-startup", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19600, 19650]
owned:
  stuck:
    cmd: "sleep 60"
    port: { published_env: PORT }
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    const allocations = await listAllocations();
    expect(allocations[result.stackId!]).toBeUndefined();
  }, 10_000);

  it("kills the owned child process so it doesn't outlive the lich call", async () => {
    // trap '' TERM means without SIGTERM→SIGKILL escalation the child would orphan
    writeYaml(`
version: "1"
runtime:
  port_range: [19700, 19750]
owned:
  stuck:
    cmd: "trap '' TERM; echo READY-SENTINEL; sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // brief wait so SIGKILL is delivered + reaped
    await new Promise((r) => setTimeout(r, 300));

    const snap = await loadSnapshot(result.stackId!);
    expect(snap).not.toBeNull();
    const stuckSnap = snap!.services.find((s) => s.name === "stuck");
    if (stuckSnap?.pid !== undefined) {
      let alive = false;
      try {
        process.kill(stuckSnap.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 10_000);

  it("treats a pre-aborted signal as immediate cancellation", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const controller = new AbortController();
    controller.abort();

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(elapsedMs).toBeLessThan(1000);
    expect(result.exitCode).toBe(1);
  }, 10_000);
});

describe("lich binary — SIGINT handler integration", () => {
  // Bun's test runner doesn't accept a timeout as beforeAll's 2nd arg (vitest does)
  beforeAll(() => {
    if (!existsSync(lichBinary)) {
      const build = spawnSync("bun", ["run", "build"], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      if (build.status !== 0) {
        throw new Error(
          `failed to build lich binary: ${build.stderr || build.stdout}`,
        );
      }
    }
    if (!existsSync(lichBinary)) {
      throw new Error(`lich binary still missing at ${lichBinary}`);
    }
  });

  it("exits within 2s of SIGINT when waiting on an unreachable tcp probe", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19900, 19950]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const proc = spawn(lichBinary, ["up", "--json"], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childToReap = proc;

    let stdoutBuf = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {
      /* drain */
    });

    // wait for the service to begin starting so SIGINT lands after the signal handler is armed
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline) {
      if (stdoutBuf.includes('"type":"service"')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stdoutBuf).toContain('"type":"service"');

    const startedAt = Date.now();
    proc.kill("SIGINT");

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
    });
    const elapsedMs = Date.now() - startedAt;
    childToReap = null;

    expect(elapsedMs).toBeLessThan(1800);
    // 130 = 128 + 2 (conventional SIGINT exit code)
    expect(exitCode).toBe(130);

    const stacks = (await import("node:fs/promises")).readdir(
      join(homeDir, "stacks"),
    );
    const stackIds = await stacks;
    expect(stackIds.length).toBeGreaterThan(0);
    const stackId = stackIds[0]!;
    createdStackIds.push(stackId);

    const snap = await loadSnapshot(stackId);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("failed");
  }, 30_000);

  it("force-exits with 130 on a second SIGINT", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [20000, 20050]
owned:
  stuck:
    cmd: "trap '' TERM; sleep 60"
    ready_when:
      tcp: "localhost:1"
`);

    const proc = spawn(lichBinary, ["up", "--json"], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childToReap = proc;

    let stdoutBuf = "";
    let stderrBuf = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
    });

    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline) {
      if (stdoutBuf.includes('"type":"service"')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // attach exit listener BEFORE any signal so we never miss an early exit
    let exitCode: number | null = null;
    let exited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve(code);
      });
    });

    // wait for first-SIGINT ack before sending the second — otherwise the
    // second can race the handler installation
    proc.kill("SIGINT");
    const ackDeadline = Date.now() + 3_000;
    while (Date.now() < ackDeadline) {
      if (stderrBuf.includes("cancelling") || exited) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stderrBuf).toContain("cancelling");

    // first SIGINT may have completed cleanup faster than SIGTERM grace —
    // legitimate, but doesn't exercise force-quit; first-SIGINT test covers it
    if (exited) {
      expect(exitCode).toBe(130);
      childToReap = null;
      return;
    }

    const startedAt = Date.now();
    proc.kill("SIGINT");

    await exitPromise;
    const elapsedMs = Date.now() - startedAt;
    childToReap = null;

    // 2s < 5s SIGTERM grace: if force-quit weren't wired, elapsed would land near 5s
    expect(elapsedMs).toBeLessThan(2000);
    expect(exitCode).toBe(130);

    const stacksDir = join(homeDir, "stacks");
    if (existsSync(stacksDir)) {
      const ids = (await import("node:fs")).readdirSync(stacksDir);
      for (const id of ids) createdStackIds.push(id);
    }
  }, 30_000);
});
