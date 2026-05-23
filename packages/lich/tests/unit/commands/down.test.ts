/**
 * Unit tests for `lich down`.
 *
 * Coverage (Plan 1 Task 24 / LEV-291):
 *   - No state.json → exit 0, "no stack found" message.
 *   - Already-stopped stack → exit 0, no-op (idempotent).
 *   - Single owned service with live PID → SIGTERM kills it; state→stopped;
 *     ports released.
 *   - Owned service with stop_cmd → stop_cmd invoked (sentinel file);
 *     SIGTERM is NOT used.
 *   - Single compose service → compose `down -v` invoked via exec seam.
 *   - before_down hooks run in reverse-topo order (sentinel mtime check).
 *   - before_down hook failure → warning recorded, teardown continues.
 *   - Already-dead PID → no error; service state→stopped silently.
 *   - Ports released exactly once with the correct stackId.
 *   - Second call → no-op exit 0.
 *
 * Test setup mirrors `up.test.ts` and `nuke.test.ts`: each test gets a fresh
 * LICH_HOME tmpdir and a fresh project tmpdir with a seeded lich.yaml.
 * Compose detection + exec are stubbed via the existing test seams so docker
 * is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runDown } from "../../../src/commands/down.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  readSnapshot,
  writeSnapshot,
  type StackSnapshot,
  type ServiceSnapshot,
} from "../../../src/state/snapshot.js";
import {
  allocate,
  listAllocations,
  release,
} from "../../../src/ports/allocator.js";
import { _exec, type ExecFn } from "../../../src/compose/runner.js";
import { _probe } from "../../../src/compose/detect.js";

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;
let composeCalls: Array<{ cmd: string; args: string[] }>;
let spawnedChildren: ChildProcess[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-down-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-down-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  spawnedChildren = [];

  // Stub the compose CLI probe so detection succeeds without docker.
  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";

  // Record (don't actually exec) compose invocations.
  originalExec = _exec.current;
  composeCalls = [];
  _exec.current = async (cmd, args) => {
    composeCalls.push({ cmd, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
});

afterEach(async () => {
  // Belt-and-braces: kill any test-spawned child still alive.
  for (const child of spawnedChildren) {
    if (typeof child.pid === "number") {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  // Release any port allocations the test created.
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
  _exec.current = originalExec;
  _probe.current = originalProbe;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

function getStackId(): string {
  // detectWorktree requires lich.yaml present in projectDir (it walks up
  // looking for it). All tests below call writeYaml(...) first.
  return detectWorktree(projectDir).stack_id;
}

/**
 * Spawn a long-lived child process that handles SIGTERM gracefully.
 * Returns the PID. The child is registered for afterEach cleanup.
 */
function spawnLongLivedChild(): number {
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  spawnedChildren.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn child");
  }
  return child.pid;
}

async function seedSnapshot(
  overrides: Partial<StackSnapshot> & {
    services: ServiceSnapshot[];
  },
): Promise<string> {
  const wt = detectWorktree(projectDir);
  const snap: StackSnapshot = {
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    ...overrides,
  };
  await writeSnapshot(snap);
  createdStackIds.push(wt.stack_id);
  return wt.stack_id;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// No state.json → exit 0
// ---------------------------------------------------------------------------

describe("runDown — no state", () => {
  it("returns exit 0 with 'no stack found' when no state.json exists", async () => {
    writeYaml(`version: "1"\n`);
    const { stream, chunks } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toEqual([]);
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out).toContain("no stack found");
  });
});

// ---------------------------------------------------------------------------
// Already stopped → no-op
// ---------------------------------------------------------------------------

describe("runDown — already stopped", () => {
  it("is a no-op when status:stopped already; second call also no-op", async () => {
    writeYaml(`version: "1"\n`);
    const stackId = await seedSnapshot({
      status: "stopped",
      services: [{ name: "svc", kind: "owned", state: "stopped" }],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toEqual([]);
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out).toContain("already stopped");

    // No compose calls were made.
    expect(composeCalls).toEqual([]);

    // State.json still present and still stopped.
    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");

    // Second call: same outcome.
    const { stream: stream2 } = captureStdout();
    const result2 = await runDown({ cwd: projectDir, out: stream2 });
    expect(result2.exitCode).toBe(0);
    expect(result2.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Owned service with live PID → SIGTERM teardown
// ---------------------------------------------------------------------------

describe("runDown — owned service SIGTERM teardown", () => {
  it("SIGTERMs the PID, state→stopped, ports released", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19200, 19299]
owned:
  longlived:
    cmd: "sleep 60"
`);
    const pid = spawnLongLivedChild();

    const stackId = await seedSnapshot({
      services: [
        {
          name: "longlived",
          kind: "owned",
          state: "ready",
          pid,
          allocated_ports: { default: 19200 },
        },
      ],
    });

    // Seed a port allocation in the registry so we can verify release.
    await allocate({
      stackId,
      logicalPorts: { "owned-single:longlived": 19200 },
      range: [19200, 19299],
    });
    const allocBefore = await listAllocations();
    expect(allocBefore[stackId]).toBeDefined();

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    expect(result.exitCode).toBe(0);

    // Process must have been killed.
    await waitFor(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);

    // State.json: status:stopped, service state:stopped.
    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "longlived")?.state).toBe(
      "stopped",
    );

    // Ports released.
    const allocAfter = await listAllocations();
    expect(allocAfter[stackId]).toBeUndefined();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Owned service with stop_cmd → stop_cmd invoked, no SIGTERM
// ---------------------------------------------------------------------------

describe("runDown — owned service stop_cmd", () => {
  it("runs stop_cmd via /bin/sh -c and does not SIGTERM the recorded PID", async () => {
    const sentinel = join(projectDir, "stop.ran");
    writeYaml(`
version: "1"
runtime:
  port_range: [19300, 19399]
owned:
  managed:
    cmd: "sleep 60"
    stop_cmd: "touch ${shellQuote(sentinel)}"
`);

    // Spawn a real child and record its PID. If our stop path used SIGTERM
    // (it shouldn't, because stop_cmd takes priority), the child would die.
    // We assert that the child is STILL ALIVE at end of teardown — proves
    // stop_cmd was the path taken.
    const pid = spawnLongLivedChild();

    const stackId = await seedSnapshot({
      services: [
        {
          name: "managed",
          kind: "owned",
          state: "ready",
          pid,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    // stop_cmd wrote its sentinel.
    expect(existsSync(sentinel)).toBe(true);

    // Original child still alive (stop_cmd path, not SIGTERM path).
    expect(isAlive(pid)).toBe(true);

    // State persisted as stopped.
    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "managed")?.state).toBe(
      "stopped",
    );
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Compose service → compose down -v invoked
// ---------------------------------------------------------------------------

describe("runDown — compose service teardown", () => {
  it("invokes `compose down -v` with the lich-<stack_id> project name", async () => {
    writeYaml(`
version: "1"
services:
  pg:
    image: postgres:15
`);

    const stackId = await seedSnapshot({
      services: [{ name: "pg", kind: "compose", state: "ready" }],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    // One compose call: down -v (no --remove-orphans).
    expect(composeCalls).toHaveLength(1);
    const call = composeCalls[0];
    expect(call.cmd).toBe("docker");
    expect(call.args).toContain("compose");
    expect(call.args).toContain("down");
    expect(call.args).toContain("-v");
    expect(call.args).not.toContain("--remove-orphans");

    // Project name follows the up convention: lich-<stack_id>.
    const projectIdx = call.args.indexOf("-p");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[projectIdx + 1]).toBe(`lich-${stackId}`);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "pg")?.state).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// before_down hooks run in reverse-topo order
// ---------------------------------------------------------------------------

describe("runDown — before_down ordering", () => {
  it("runs per-service before_down hooks in reverse-topo (B before A when B depends on A)", async () => {
    const aSentinel = join(projectDir, "a.down");
    const bSentinel = join(projectDir, "b.down");

    writeYaml(`
version: "1"
runtime:
  port_range: [19400, 19499]
owned:
  a:
    cmd: "sleep 60"
    lifecycle:
      before_down:
        - "touch ${shellQuote(aSentinel)}; sleep 0.1"
  b:
    cmd: "sleep 60"
    depends_on: [a]
    lifecycle:
      before_down:
        - "touch ${shellQuote(bSentinel)}; sleep 0.1"
`);

    await seedSnapshot({
      services: [
        { name: "a", kind: "owned", state: "ready" },
        { name: "b", kind: "owned", state: "ready" },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(aSentinel)).toBe(true);
    expect(existsSync(bSentinel)).toBe(true);

    // B depends on A → A starts first, B starts after. Teardown is the
    // reverse: B before A. The sentinel mtimes must reflect that.
    const { statSync } = await import("node:fs");
    const aMtime = statSync(aSentinel).mtimeMs;
    const bMtime = statSync(bSentinel).mtimeMs;
    expect(bMtime).toBeLessThanOrEqual(aMtime);
  });
});

// ---------------------------------------------------------------------------
// before_down hook failure → warning, teardown continues
// ---------------------------------------------------------------------------

describe("runDown — before_down hook failure", () => {
  it("records a warning and continues teardown when before_down exits non-zero", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
    lifecycle:
      before_down:
        - "exit 7"
`);

    const stackId = await seedSnapshot({
      services: [{ name: "svc", kind: "owned", state: "ready" }],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    // Exit code stays 0 (best-effort).
    expect(result.exitCode).toBe(0);

    // Warning recorded for the failed hook.
    const hookWarnings = result.warnings.filter(
      (w) => w.phase === "before_down" && w.service === "svc",
    );
    expect(hookWarnings.length).toBeGreaterThanOrEqual(1);
    expect(hookWarnings[0].message).toContain("exit");

    // Teardown still completed: status:stopped.
    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "svc")?.state).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// Dead PID → silent no-op
// ---------------------------------------------------------------------------

describe("runDown — dead PID is a silent no-op", () => {
  it("does not error when the recorded PID is already dead", async () => {
    writeYaml(`
version: "1"
owned:
  ghost:
    cmd: "sleep 60"
`);

    // Pick a PID that's almost certainly not in use.
    const stackId = await seedSnapshot({
      services: [
        {
          name: "ghost",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    // No warnings (dead-pid case is silent).
    const stopWarnings = result.warnings.filter(
      (w) => w.phase === "stop_owned",
    );
    expect(stopWarnings).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "ghost")?.state).toBe(
      "stopped",
    );
  });
});

// ---------------------------------------------------------------------------
// Ports release with correct stackId
// ---------------------------------------------------------------------------

describe("runDown — ports release", () => {
  it("releases ports under the correct stackId and only that stackId", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19599]
owned:
  svc:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      services: [{ name: "svc", kind: "owned", state: "stopped" }],
    });

    // Seed allocations for this stack AND an unrelated stack — the
    // unrelated one must survive teardown.
    await allocate({
      stackId,
      logicalPorts: { "owned-single:svc": 19500 },
      range: [19500, 19599],
    });
    await allocate({
      stackId: "other-stack-id",
      logicalPorts: { "x": 19501 },
      range: [19500, 19599],
    });
    createdStackIds.push("other-stack-id");

    const before = await listAllocations();
    expect(before[stackId]).toBeDefined();
    expect(before["other-stack-id"]).toBeDefined();

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const after = await listAllocations();
    expect(after[stackId]).toBeUndefined();
    // The other stack's allocation is untouched.
    expect(after["other-stack-id"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Second call → no-op
// ---------------------------------------------------------------------------

describe("runDown — idempotency", () => {
  it("a second invocation is a clean no-op", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);

    await seedSnapshot({
      services: [{ name: "svc", kind: "owned", state: "ready" }],
    });

    const { stream } = captureStdout();
    const first = await runDown({ cwd: projectDir, out: stream });
    expect(first.exitCode).toBe(0);

    composeCalls.length = 0;
    const { stream: stream2, chunks: chunks2 } = captureStdout();
    const second = await runDown({ cwd: projectDir, out: stream2 });
    expect(second.exitCode).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(composeCalls).toEqual([]);

    const out = Buffer.concat(chunks2).toString("utf8");
    expect(out).toContain("already stopped");
  });
});
