import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { serviceLogPath } from "../../../src/state/directory.js";

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

  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";

  originalExec = _exec.current;
  composeCalls = [];
  _exec.current = async (cmd, args) => {
    composeCalls.push({ cmd, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
});

afterEach(async () => {
  for (const child of spawnedChildren) {
    if (typeof child.pid === "number") {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
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
  return detectWorktree(projectDir).stack_id;
}

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

    expect(composeCalls).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");

    const { stream: stream2 } = captureStdout();
    const result2 = await runDown({ cwd: projectDir, out: stream2 });
    expect(result2.exitCode).toBe(0);
    expect(result2.warnings).toEqual([]);
  });
});

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

    await waitFor(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "longlived")?.state).toBe(
      "stopped",
    );

    const allocAfter = await listAllocations();
    expect(allocAfter[stackId]).toBeUndefined();
  }, 15_000);
});

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

    // child must still be alive at end — proves stop_cmd ran instead of SIGTERM
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

    expect(existsSync(sentinel)).toBe(true);

    expect(isAlive(pid)).toBe(true);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "managed")?.state).toBe(
      "stopped",
    );
  }, 15_000);

  it("surfaces stop_cmd stderr tail in the warning when stop_cmd exits non-zero", async () => {
    writeYaml(`
version: "1"
owned:
  flaky:
    cmd: "sleep 60"
    stop_cmd: "echo failure-detail 1>&2; exit 7"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "flaky",
          kind: "owned",
          state: "stopped",
          // dead pid so the SIGTERM path doesn't fire
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    expect(result.exitCode).toBe(0);

    const stopWarnings = result.warnings.filter(
      (w) => w.phase === "stop_owned" && w.service === "flaky",
    );
    expect(stopWarnings).toHaveLength(1);
    const message = stopWarnings[0].message;
    expect(message).toContain("7");
    expect(message).toContain("failure-detail");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  }, 15_000);

  it("logs an info note when stop_cmd takes longer than the slow threshold but exits 0", async () => {
    // 5s threshold — sleep 6s to trigger
    writeYaml(`
version: "1"
owned:
  slow:
    cmd: "sleep 60"
    stop_cmd: "sleep 6; exit 0"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "slow",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_641,
        },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    // slow + exit 0 is an info-level note, not a warning
    const stopWarnings = result.warnings.filter(
      (w) => w.phase === "stop_owned" && w.service === "slow",
    );
    expect(stopWarnings).toEqual([]);

    const stdout = Buffer.concat(chunks).toString("utf8");
    expect(stdout).toContain("info:");
    expect(stdout).toContain("[slow]");
    expect(stdout).toMatch(/stop_cmd took \d/);
    expect(stdout).toContain("verify resources are actually gone");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  }, 20_000);
});

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

    // 2 calls: down -v, then ps -q verification
    expect(composeCalls).toHaveLength(2);
    const downCall = composeCalls[0];
    expect(downCall.cmd).toBe("docker");
    expect(downCall.args).toContain("compose");
    expect(downCall.args).toContain("down");
    expect(downCall.args).toContain("-v");
    expect(downCall.args).not.toContain("--remove-orphans");

    const projectIdx = downCall.args.indexOf("-p");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(downCall.args[projectIdx + 1]).toBe(`lich-${stackId}`);

    const psCall = composeCalls[1];
    expect(psCall.cmd).toBe("docker");
    expect(psCall.args).toContain("compose");
    expect(psCall.args).toContain("ps");
    expect(psCall.args).toContain("-q");
    const psProjectIdx = psCall.args.indexOf("-p");
    expect(psProjectIdx).toBeGreaterThanOrEqual(0);
    expect(psCall.args[psProjectIdx + 1]).toBe(`lich-${stackId}`);

    expect(
      result.warnings.filter((w) => w.phase === "compose_down"),
    ).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "pg")?.state).toBe("stopped");
  });

  it("force-removes a container that compose down left running, then warns", async () => {
    // Scripted sequence:
    //   1. compose down -v   → exit 0
    //   2. compose ps -q     → returns leaked id
    //   3. docker rm -f <id> → exit 0 (salvage)
    //   4. compose ps -q     → returns "" (now empty)
    writeYaml(`
version: "1"
services:
  pg:
    image: postgres:15
`);

    const stackId = await seedSnapshot({
      services: [{ name: "pg", kind: "compose", state: "ready" }],
    });

    const leakedId = "leftover-abc123";
    const calls: Array<{ cmd: string; args: string[]; stdout: string }> = [];
    let psCallCount = 0;
    _exec.current = async (cmd, args) => {
      let stdout = "";
      if (args.includes("rm") && args.includes("-f")) {
        // docker rm -f <id>
      } else if (args[args.length - 2] === "ps" && args[args.length - 1] === "-q") {
        psCallCount++;
        if (psCallCount === 1) stdout = `${leakedId}\n`;
      }
      calls.push({ cmd, args, stdout });
      return { exitCode: 0, stdout, stderr: "" };
    };
    composeCalls = calls.map((c) => ({ cmd: c.cmd, args: c.args }));

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const downCall = calls.find((c) => c.args.includes("down"));
    expect(downCall).toBeDefined();

    const psCalls = calls.filter(
      (c) =>
        c.args[c.args.length - 2] === "ps" &&
        c.args[c.args.length - 1] === "-q",
    );
    expect(psCalls.length).toBe(2);

    const rmCall = calls.find(
      (c) => c.args[0] === "rm" && c.args[1] === "-f" && c.args[2] === leakedId,
    );
    expect(rmCall).toBeDefined();
    expect(rmCall?.cmd).toBe("docker");

    const composeWarnings = result.warnings.filter(
      (w) => w.phase === "compose_down",
    );
    expect(composeWarnings.length).toBeGreaterThanOrEqual(1);
    expect(composeWarnings.some((w) => w.message.includes("force-removed"))).toBe(
      true,
    );
    expect(composeWarnings[0].message).toContain(`lich-${stackId}`);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("warns loudly when force-remove also fails to clear the container", async () => {
    // Same shape as salvage test but second ps -q ALSO returns the leaked
    // container — i.e. docker rm -f reported success but didn't remove it
    writeYaml(`
version: "1"
services:
  pg:
    image: postgres:15
`);

    const stackId = await seedSnapshot({
      services: [{ name: "pg", kind: "compose", state: "ready" }],
    });

    const stuckId = "stuck-xyz789";
    _exec.current = async (cmd, args) => {
      if (
        args[args.length - 2] === "ps" &&
        args[args.length - 1] === "-q"
      ) {
        return { exitCode: 0, stdout: `${stuckId}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const composeWarnings = result.warnings.filter(
      (w) => w.phase === "compose_down",
    );
    expect(composeWarnings.length).toBeGreaterThanOrEqual(1);
    const stuckWarning = composeWarnings.find((w) =>
      w.message.includes(stuckId),
    );
    expect(stuckWarning).toBeDefined();
    expect(stuckWarning?.message).toMatch(/could not fully remove/);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });
});

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

    // B depends on A; teardown is the reverse: B before A
    const { statSync } = await import("node:fs");
    const aMtime = statSync(aSentinel).mtimeMs;
    const bMtime = statSync(bSentinel).mtimeMs;
    expect(bMtime).toBeLessThanOrEqual(aMtime);
  });
});

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

    expect(result.exitCode).toBe(0);

    const hookWarnings = result.warnings.filter(
      (w) => w.phase === "before_down" && w.service === "svc",
    );
    expect(hookWarnings.length).toBeGreaterThanOrEqual(1);
    expect(hookWarnings[0].message).toContain("exit");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "svc")?.state).toBe("stopped");
  });
});

describe("runDown — dead PID is a silent no-op", () => {
  it("does not error when the recorded PID is already dead", async () => {
    writeYaml(`
version: "1"
owned:
  ghost:
    cmd: "sleep 60"
`);

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

    // unrelated stack allocation must survive teardown
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
    expect(after["other-stack-id"]).toBeDefined();
  });
});

describe("runDown — stop_cmd env carries worktree-derived values", () => {
  it("passes SUPABASE_PROJECT_ID resolved from ${worktree.id} into stop_cmd env", async () => {
    const sentinel = join(projectDir, "supabase.project");

    writeYaml(`
version: "1"
owned:
  supabase:
    cmd: "true"
    oneshot: true
    env:
      SUPABASE_PROJECT_ID: "p-\${worktree.id}"
    stop_cmd: "printf '%s' \\"\${SUPABASE_PROJECT_ID}\\" > ${shellQuote(sentinel)}"
`);

    const wt = detectWorktree(projectDir);
    const expected = `p-${wt.id}`;

    const stackId = await seedSnapshot({
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "stopped",
          // dead pid so SIGTERM is silent no-op — only stop_cmd writes sentinel
          pid: 2_147_483_641,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe(expected);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  }, 15_000);
});

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

describe("runDown — LogTail lifecycle", () => {
  it("preserves the on-disk log file after teardown so post-down log tooling can still read it", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);
    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          // no pid — simulates `lich down` after the up-terminal closed
          state: "ready",
        },
      ],
    });

    const logPath = serviceLogPath(stackId, "svc");
    mkdirSync(dirname(logPath), { recursive: true });
    const logBody =
      "2026-05-24T22:00:00Z svc starting\n" +
      "2026-05-24T22:00:01Z svc ready\n";
    writeFileSync(logPath, logBody, "utf8");

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    expect(result.exitCode).toBe(0);
    const logWarnings = result.warnings.filter(
      (w) => w.message.toLowerCase().includes("log") ||
        w.phase.toLowerCase().includes("log"),
    );
    expect(logWarnings).toEqual([]);

    // log file must survive down — only `lich nuke` removes it
    expect(existsSync(logPath)).toBe(true);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "svc")?.state).toBe(
      "stopped",
    );
  });

  it("completes cleanly when down inherits no in-process LogTail registry (the common cross-process case)", async () => {
    const sentinel = join(projectDir, "stop.ran");
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
    stop_cmd: "touch ${shellQuote(sentinel)}"
`);
    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "ready",
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    expect(result.exitCode).toBe(0);
    expect(existsSync(sentinel)).toBe(true);

    const suspectWarnings = result.warnings.filter((w) => {
      const blob = `${w.phase} ${w.message}`.toLowerCase();
      return (
        blob.includes("logtail") ||
        blob.includes("log_tail") ||
        blob.includes("tail registry")
      );
    });
    expect(suspectWarnings).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });
});

describe("runDown — profile before_down composition", () => {
  it("runs profile before_down first, then top-level before_down (LIFO)", async () => {
    const ledger = join(projectDir, "before_down.ledger");

    writeYaml(`
version: "1"
runtime:
  port_range: [19600, 19699]
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf 'TOP\\n' >> ${shellQuote(ledger)}"
profiles:
  dev:
    default: true
    owned: [svc]
    lifecycle:
      before_down:
        - "printf 'PROFILE\\n' >> ${shellQuote(ledger)}"
`);

    const stackId = await seedSnapshot({
      active_profile: "dev",
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const bdWarnings = result.warnings.filter(
      (w) => w.phase === "before_down",
    );
    expect(bdWarnings).toEqual([]);
    const prWarnings = result.warnings.filter(
      (w) => w.phase === "profile_resolve",
    );
    expect(prWarnings).toEqual([]);

    expect(existsSync(ledger)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toEqual(["PROFILE", "TOP"]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("warns when active_profile in snapshot is missing from yaml (post-edit drift)", async () => {
    const topSentinel = join(projectDir, "top.ran");

    // yaml has profiles but not the one the snapshot references
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "touch ${shellQuote(topSentinel)}"
profiles:
  other:
    default: true
    owned: [svc]
`);

    const stackId = await seedSnapshot({
      active_profile: "gone",
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_641,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const prWarnings = result.warnings.filter(
      (w) => w.phase === "profile_resolve",
    );
    expect(prWarnings).toHaveLength(1);
    expect(prWarnings[0].message).toContain("gone");

    expect(existsSync(topSentinel)).toBe(true);

    const bdWarnings = result.warnings.filter(
      (w) => w.phase === "before_down",
    );
    expect(bdWarnings).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("snapshot without active_profile still tears down cleanly via top-level before_down only", async () => {
    const topSentinel = join(projectDir, "top.ran");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "touch ${shellQuote(topSentinel)}"
profiles:
  dev:
    default: true
    owned: [svc]
    lifecycle:
      before_down:
        - "echo profile-should-not-run-without-active_profile 1>&2; exit 1"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_642,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const prWarnings = result.warnings.filter(
      (w) => w.phase === "profile_resolve",
    );
    expect(prWarnings).toEqual([]);

    expect(existsSync(topSentinel)).toBe(true);

    // dev profile's before_down would have exited 1; no warning proves it
    // wasn't executed
    const bdWarnings = result.warnings.filter(
      (w) => w.phase === "before_down",
    );
    expect(bdWarnings).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });
});

describe("runDown — after_down lifecycle", () => {
  it("runs after_down AFTER before_down (shared ledger pins order)", async () => {
    const ledger = join(projectDir, "down.ledger");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf 'BEFORE\\n' >> ${shellQuote(ledger)}"
  after_down:
    - "printf 'AFTER\\n' >> ${shellQuote(ledger)}"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const hookWarnings = result.warnings.filter(
      (w) => w.phase === "before_down" || w.phase === "after_down",
    );
    expect(hookWarnings).toEqual([]);

    expect(existsSync(ledger)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toEqual(["BEFORE", "AFTER"]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("runs after_down AFTER per-service teardown (sentinel appears after SIGTERM exits the process)", async () => {
    // after_down checks the live pid; "dead" only if it ran after SIGTERM
    const pid = spawnLongLivedChild();
    const sentinel = join(projectDir, "post-teardown.txt");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "kill -0 ${pid} 2>/dev/null && printf 'alive' > ${shellQuote(sentinel)} || printf 'dead' > ${shellQuote(sentinel)}"
`);

    const stackId = await seedSnapshot({
      services: [{ name: "svc", kind: "owned", state: "ready", pid }],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe("dead");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.services.find((s) => s.name === "svc")?.state).toBe(
      "stopped",
    );
  });

  it("records a warning and continues teardown when after_down exits non-zero (best-effort)", async () => {
    const sentinel = join(projectDir, "after-down-second.txt");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "echo nope 1>&2; exit 7"
    - "touch ${shellQuote(sentinel)}"
`);

    const stackId = await seedSnapshot({
      services: [{ name: "svc", kind: "owned", state: "ready" }],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });

    expect(result.exitCode).toBe(0);

    const adWarnings = result.warnings.filter(
      (w) => w.phase === "after_down",
    );
    expect(adWarnings.length).toBeGreaterThanOrEqual(1);
    expect(adWarnings[0]!.message).toContain("exit");

    // second entry still ran — proves we didn't bail on the first failure
    expect(existsSync(sentinel)).toBe(true);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("composes profile after_down BEFORE top-level after_down (LIFO, mirror of before_down)", async () => {
    const ledger = join(projectDir, "after_down.ledger");

    writeYaml(`
version: "1"
runtime:
  port_range: [19700, 19799]
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "printf 'TOP\\n' >> ${shellQuote(ledger)}"
profiles:
  dev:
    default: true
    owned: [svc]
    lifecycle:
      after_down:
        - "printf 'PROFILE\\n' >> ${shellQuote(ledger)}"
`);

    const stackId = await seedSnapshot({
      active_profile: "dev",
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_641,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const adWarnings = result.warnings.filter(
      (w) => w.phase === "after_down",
    );
    expect(adWarnings).toEqual([]);
    const prWarnings = result.warnings.filter(
      (w) => w.phase === "profile_resolve",
    );
    expect(prWarnings).toEqual([]);

    expect(existsSync(ledger)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toEqual(["PROFILE", "TOP"]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("still runs top-level after_down when active profile in snapshot is missing from yaml (drift fallback)", async () => {
    const topSentinel = join(projectDir, "after-down-top.ran");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "touch ${shellQuote(topSentinel)}"
profiles:
  other:
    default: true
    owned: [svc]
`);

    const stackId = await seedSnapshot({
      active_profile: "gone",
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_642,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    // one profile_resolve warning — profile is resolved once across both
    // before_down + after_down so the diagnostic isn't duplicated
    const prWarnings = result.warnings.filter(
      (w) => w.phase === "profile_resolve",
    );
    expect(prWarnings).toHaveLength(1);
    expect(prWarnings[0]!.message).toContain("gone");

    expect(existsSync(topSentinel)).toBe(true);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });
});

describe("runDown — top-level env reaches before_down + after_down", () => {
  it("before_down sees TOP_LEVEL_VAR from top-level env:", async () => {
    const sentinel = join(projectDir, "before-down.env");

    writeYaml(`
version: "1"
env:
  TOP_LEVEL_VAR: "from-top-level"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf '%s' \\"\${TOP_LEVEL_VAR}\\" > ${shellQuote(sentinel)}"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const envWarnings = result.warnings.filter(
      (w) => w.phase === "lifecycle_env",
    );
    expect(envWarnings).toEqual([]);
    const bdWarnings = result.warnings.filter(
      (w) => w.phase === "before_down",
    );
    expect(bdWarnings).toEqual([]);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe("from-top-level");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("after_down sees TOP_LEVEL_VAR from top-level env:", async () => {
    const sentinel = join(projectDir, "after-down.env");

    writeYaml(`
version: "1"
env:
  TOP_LEVEL_VAR: "from-top-level"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "printf '%s' \\"\${TOP_LEVEL_VAR}\\" > ${shellQuote(sentinel)}"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const envWarnings = result.warnings.filter(
      (w) => w.phase === "lifecycle_env",
    );
    expect(envWarnings).toEqual([]);
    const adWarnings = result.warnings.filter(
      (w) => w.phase === "after_down",
    );
    expect(adWarnings).toEqual([]);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe("from-top-level");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("before_down sees env_from shell-out values", async () => {
    const sentinel = join(projectDir, "env-from.env");

    writeYaml(`
version: "1"
env_from:
  - cmd: "printf 'FROM_SHELL=value-from-shell\\n'"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf '%s' \\"\${FROM_SHELL}\\" > ${shellQuote(sentinel)}"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe("value-from-shell");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("before_down sees ${worktree.id} interpolation in top-level env:", async () => {
    const sentinel = join(projectDir, "worktree-interp.env");

    writeYaml(`
version: "1"
env:
  SUPABASE_WORKDIR: "/tmp/supabase-\${worktree.id}"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf '%s' \\"\${SUPABASE_WORKDIR}\\" > ${shellQuote(sentinel)}"
`);

    const wt = detectWorktree(projectDir);
    const expected = `/tmp/supabase-${wt.id}`;

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe(expected);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("after_down sees per-owned-service port env vars from the snapshot", async () => {
    const sentinel = join(projectDir, "port-env.env");

    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
    port:
      published_env: SVC_HOST_PORT
lifecycle:
  after_down:
    - "printf '%s' \\"\${SVC_HOST_PORT}\\" > ${shellQuote(sentinel)}"
`);

    const allocatedPort = 19850;
    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
          allocated_ports: { default: allocatedPort },
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe(String(allocatedPort));

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("env: { CANARY: null } removes CANARY from the lifecycle env", async () => {
    const sentinel = join(projectDir, "null-unset.env");

    // seed CANARY in the parent env — only down's null-unset can remove it
    const previousCanary = process.env.CANARY;
    process.env.CANARY = "from-parent";

    try {
      writeYaml(`
version: "1"
env:
  CANARY: null
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf '%s' \\"\${CANARY:-fallback}\\" > ${shellQuote(sentinel)}"
`);

      const stackId = await seedSnapshot({
        services: [
          {
            name: "svc",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_640,
          },
        ],
      });

      const { stream } = captureStdout();
      const result = await runDown({ cwd: projectDir, out: stream });
      expect(result.exitCode).toBe(0);

      expect(existsSync(sentinel)).toBe(true);
      const { readFileSync } = await import("node:fs");
      // "fallback" → CANARY unset; "from-parent" → null-unset ignored; "" → set to empty
      expect(readFileSync(sentinel, "utf8")).toBe("fallback");

      const snap = await readSnapshot(stackId);
      expect(snap?.status).toBe("stopped");
    } finally {
      if (previousCanary === undefined) {
        delete process.env.CANARY;
      } else {
        process.env.CANARY = previousCanary;
      }
    }
  });

  it("profile env: overrides reach both before_down and after_down", async () => {
    const beforeSentinel = join(projectDir, "profile-before.env");
    const afterSentinel = join(projectDir, "profile-after.env");

    writeYaml(`
version: "1"
env:
  PROFILE_VAR: "from-top-level"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf '%s' \\"\${PROFILE_VAR}\\" > ${shellQuote(beforeSentinel)}"
  after_down:
    - "printf '%s' \\"\${PROFILE_VAR}\\" > ${shellQuote(afterSentinel)}"
profiles:
  dev:
    default: true
    owned: [svc]
    env:
      PROFILE_VAR: "from-profile"
`);

    const stackId = await seedSnapshot({
      active_profile: "dev",
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const { readFileSync } = await import("node:fs");
    expect(existsSync(beforeSentinel)).toBe(true);
    expect(existsSync(afterSentinel)).toBe(true);
    expect(readFileSync(beforeSentinel, "utf8")).toBe("from-profile");
    expect(readFileSync(afterSentinel, "utf8")).toBe("from-profile");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });

  it("long-form lifecycle entry with env_group: stack resolves via the lifecycle env_group resolver", async () => {
    const sentinel = join(projectDir, "env-group.env");

    writeYaml(`
version: "1"
env:
  GROUP_VAR: "from-stack-group"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - cmd: "printf '%s' \\"\${GROUP_VAR}\\" > ${shellQuote(sentinel)}"
      env_group: stack
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_640,
        },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const bdWarnings = result.warnings.filter(
      (w) => w.phase === "before_down",
    );
    expect(bdWarnings).toEqual([]);

    expect(existsSync(sentinel)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinel, "utf8")).toBe("from-stack-group");

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
  });
});

describe("runDown — phased progress output", () => {
  function parseEvents(chunks: Buffer[]): Array<Record<string, unknown>> {
    const text = Buffer.concat(chunks).toString("utf8");
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // skip interleaved non-JSON warning lines
      if (!trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* skip malformed lines */
      }
    }
    return events;
  }

  it("emits a phased progress sequence for a multi-owned-service stack", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19899]
owned:
  a:
    cmd: "sleep 60"
  b:
    cmd: "sleep 60"
    depends_on: [a]
  c:
    cmd: "sleep 60"
    depends_on: [b]
`);

    const stackId = await seedSnapshot({
      services: [
        { name: "a", kind: "owned", state: "ready", pid: 2_147_483_640 },
        { name: "b", kind: "owned", state: "ready", pid: 2_147_483_641 },
        { name: "c", kind: "owned", state: "ready", pid: 2_147_483_642 },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "json",
    });
    expect(result.exitCode).toBe(0);

    const events = parseEvents(chunks);

    // teardown is reverse-topo: deepest dependency (c) first → counter 1/3
    const ownedBegin = events.find(
      (e) =>
        e.type === "phase_begin" &&
        typeof e.name === "string" &&
        e.name.includes("stopping owned services (1/3:"),
    );
    expect(ownedBegin).toBeDefined();

    const ownedUpdates = events.filter(
      (e) =>
        e.type === "phase_update" &&
        typeof e.name === "string" &&
        e.name.includes("stopping owned services"),
    );
    expect(ownedUpdates.length).toBe(2);
    const lastUpdate = ownedUpdates[ownedUpdates.length - 1];
    expect(lastUpdate.name).toContain("(3/3:");

    const ownedEnd = events.find(
      (e) =>
        e.type === "phase_end" &&
        typeof e.name === "string" &&
        e.name.includes("stopping owned services"),
    );
    expect(ownedEnd).toBeDefined();
    expect(ownedEnd!.status).toBe("ok");
    expect(ownedEnd!.message).toBe("stopped owned services (3/3)");
    expect(typeof ownedEnd!.elapsed_ms).toBe("number");

    const summary = events.find((e) => e.type === "summary");
    expect(summary).toBeDefined();
    expect(summary!.title).toBe(`stack down: ${stackId}`);
    expect(typeof summary!.elapsed_ms).toBe("number");
  });

  it("emits a before_down hooks phase with begin/end events", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "true"
`);

    await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "ready", pid: 2_147_483_640 },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "json",
    });
    expect(result.exitCode).toBe(0);

    const events = parseEvents(chunks);

    const bdBegin = events.find(
      (e) =>
        e.type === "phase_begin" &&
        typeof e.name === "string" &&
        e.name.includes("running before_down hooks"),
    );
    expect(bdBegin).toBeDefined();
    expect(bdBegin!.name).toContain("(1/1)");

    const bdEnd = events.find(
      (e) =>
        e.type === "phase_end" &&
        typeof e.name === "string" &&
        e.name.includes("running before_down hooks"),
    );
    expect(bdEnd).toBeDefined();
    expect(bdEnd!.status).toBe("ok");
    expect(bdEnd!.message).toBe("hooks done");
    expect(typeof bdEnd!.elapsed_ms).toBe("number");
  });

  it("emits an after_down hooks phase with begin/end events", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "true"
`);

    await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "ready", pid: 2_147_483_640 },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "json",
    });
    expect(result.exitCode).toBe(0);

    const events = parseEvents(chunks);

    const adBegin = events.find(
      (e) =>
        e.type === "phase_begin" &&
        typeof e.name === "string" &&
        e.name.includes("running after_down hooks"),
    );
    expect(adBegin).toBeDefined();
    expect(adBegin!.name).toContain("(1/1)");

    const adEnd = events.find(
      (e) =>
        e.type === "phase_end" &&
        typeof e.name === "string" &&
        e.name.includes("running after_down hooks"),
    );
    expect(adEnd).toBeDefined();
    expect(adEnd!.status).toBe("ok");
    expect(adEnd!.message).toBe("hooks done");
  });

  it("emits a compose-services phase for compose-only stacks", async () => {
    writeYaml(`
version: "1"
services:
  pg:
    image: postgres:15
`);

    await seedSnapshot({
      services: [{ name: "pg", kind: "compose", state: "ready" }],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "json",
    });
    expect(result.exitCode).toBe(0);

    const events = parseEvents(chunks);

    const ownedBegin = events.find(
      (e) =>
        e.type === "phase_begin" &&
        typeof e.name === "string" &&
        e.name.includes("stopping owned services"),
    );
    expect(ownedBegin).toBeUndefined();

    const composeBegin = events.find(
      (e) =>
        e.type === "phase_begin" &&
        typeof e.name === "string" &&
        e.name.includes("stopping compose services (1/1:"),
    );
    expect(composeBegin).toBeDefined();
    expect(composeBegin!.name).toContain("pg");

    const composeEnd = events.find(
      (e) =>
        e.type === "phase_end" &&
        typeof e.name === "string" &&
        e.name.includes("stopping compose services"),
    );
    expect(composeEnd).toBeDefined();
    expect(composeEnd!.message).toBe("stopped compose services (1/1)");
  });

  it("end-to-end event order: owned-stop → before_down → compose-stop → after_down → summary", async () => {
    writeYaml(`
version: "1"
services:
  pg:
    image: postgres:15
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "true"
  after_down:
    - "true"
`);

    await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "ready", pid: 2_147_483_640 },
        { name: "pg", kind: "compose", state: "ready" },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "json",
    });
    expect(result.exitCode).toBe(0);

    const events = parseEvents(chunks);

    const beginsInOrder = events
      .filter((e) => e.type === "phase_begin")
      .map((e) => e.name as string);

    expect(beginsInOrder[0]).toMatch(/stopping owned services/);
    expect(beginsInOrder[1]).toMatch(/running before_down hooks/);
    expect(beginsInOrder[2]).toMatch(/stopping compose services/);
    expect(beginsInOrder[3]).toMatch(/running after_down hooks/);

    const summary = events.find((e) => e.type === "summary");
    expect(summary).toBeDefined();
    expect((summary!.title as string).startsWith("stack down:")).toBe(true);
  });

  it("quiet mode suppresses every progress event but still writes the summary", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "ready", pid: 2_147_483_640 },
      ],
    });

    const { stream, chunks } = captureStdout();
    const result = await runDown({
      cwd: projectDir,
      out: stream,
      outputMode: "quiet",
    });
    expect(result.exitCode).toBe(0);

    const out = Buffer.concat(chunks).toString("utf8");

    expect(out).not.toContain("▶");
    expect(out).not.toContain("✓");
    expect(out).not.toContain("stopping owned services");
    expect(out).not.toContain("hooks done");

    expect(out).toContain(`stack down: ${stackId}`);
  });
});

describe("runDown — lifecycle status persistence (LEV-531)", () => {
  it("records `ok` for before_down/after_down when they ran cleanly", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "true"
  after_down:
    - "true"
`);

    const stackId = await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "stopped", pid: 2_147_483_640 },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    expect(snap?.lifecycle).toBeDefined();
    expect(snap!.lifecycle!.before_down).toEqual({ status: "ok" });
    expect(snap!.lifecycle!.after_down).toEqual({ status: "ok" });
  });

  it("records `failed` with index/cmd/log_path when before_down exits non-zero", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "true"
    - "echo broken && exit 7"
    - "true"
`);

    const stackId = await seedSnapshot({
      services: [
        { name: "svc", kind: "owned", state: "stopped", pid: 2_147_483_640 },
      ],
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    const bd = snap!.lifecycle!.before_down!;
    expect(bd.status).toBe("failed");
    if (bd.status === "failed") {
      expect(bd.failed_index).toBe(1);
      expect(bd.total).toBe(3);
      expect(bd.failed_cmd).toBe("echo broken && exit 7");
      expect(bd.log_path).toContain(stackId);
      expect(bd.log_path).toContain("before_down.log");
    }
  });

  it("preserves snapshot.lifecycle.after_up across down (so stacks output still shows the up-time failure)", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      status: "failed",
      services: [
        { name: "svc", kind: "owned", state: "ready", pid: 2_147_483_640 },
      ],
      lifecycle: {
        before_up: { status: "ok" },
        after_up: {
          status: "failed",
          failed_index: 0,
          total: 1,
          failed_cmd: "pnpm db:reset",
          log_path: "/tmp/fake/logs/after_up.log",
        },
      },
    });

    const { stream } = captureStdout();
    const result = await runDown({ cwd: projectDir, out: stream });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    expect(snap!.lifecycle!.before_up).toEqual({ status: "ok" });
    expect(snap!.lifecycle!.after_up).toMatchObject({
      status: "failed",
      failed_index: 0,
      total: 1,
      failed_cmd: "pnpm db:reset",
    });
  });
});
