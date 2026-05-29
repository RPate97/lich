import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stackDir } from "../../../src/state/directory.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { runNuke } from "../../../src/commands/nuke.js";
import { _exec, type ExecFn } from "../../../src/compose/runner.js";
import { _probe } from "../../../src/compose/detect.js";
import { writeDaemonPid } from "../../../src/daemon/pid-file.js";

let home: string;
let prevLichHome: string | undefined;
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;
let spawnedChildren: ChildProcess[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-nuke-daemon-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;

  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";

  originalExec = _exec.current;
  _exec.current = async () => ({ exitCode: 0, stdout: "", stderr: "" });

  spawnedChildren = [];
});

afterEach(() => {
  for (const child of spawnedChildren) {
    try {
      if (typeof child.pid === "number") {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }

  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
  _exec.current = originalExec;
  _probe.current = originalProbe;
});

class Sink {
  chunks: string[] = [];
  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  };
  text(): string {
    return this.chunks.join("");
  }
}

function makeSink(): { sink: Sink; out: NodeJS.WritableStream } {
  const sink = new Sink();
  return { sink, out: sink as unknown as NodeJS.WritableStream };
}

function spawnFakeDaemon(): { child: ChildProcess; pid: number } {
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  spawnedChildren.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("spawnFakeDaemon: child.pid is not a number");
  }
  return { child, pid: child.pid };
}

function spawnSigtermDeafDaemon(): { child: ChildProcess; pid: number } {
  const child = spawn(
    "node",
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ],
    { stdio: "ignore", detached: false },
  );
  spawnedChildren.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("spawnSigtermDeafDaemon: child.pid is not a number");
  }
  return { child, pid: child.pid };
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runNuke — daemon alive", () => {
  it("SIGTERMs the daemon, waits for clean exit, and clears the PID file", async () => {
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);

    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});

describe("runNuke — daemon ignores SIGTERM", () => {
  // timeout bumped to 15s for the 5s grace window + SIGKILL reap
  it("SIGKILLs the daemon after the grace window expires", async () => {
    const { child, pid } = spawnSigtermDeafDaemon();
    await writeDaemonPid(pid);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);

    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  }, 15_000);
});

describe("runNuke — stale PID file", () => {
  it("clears the PID file without trying to signal a dead process", async () => {
    // PIDs typically wrap below 100k; 999999 is safely past
    const DEAD_PID = 999_999;
    await writeDaemonPid(DEAD_PID);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);

    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});

describe("runNuke — no PID file", () => {
  it("is a silent no-op when no daemon.pid exists", async () => {
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);

    expect(sink.text()).toContain("no stacks to nuke");
    expect(sink.text()).not.toMatch(/^warning:/m);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("kills the daemon even when no stacks exist (escape-hatch contract)", async () => {
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");

    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

describe("runNuke — per-stack teardown survives daemon-kill failures", () => {
  it("nukes stacks first, then signals the daemon (correct ordering)", async () => {
    const { child, pid } = spawnFakeDaemon();
    await writeDaemonPid(pid);

    await writeSnapshot({
      stack_id: "ordering-test",
      worktree_name: "ordering",
      worktree_path: home,
      status: "stopped",
      started_at: new Date().toISOString(),
      services: [],
    });

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].stackId).toBe("ordering-test");
    expect(result.outcomes[0].status).toBe("nuked");

    expect(existsSync(stackDir("ordering-test"))).toBe(false);

    await waitForExit(child);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("still nukes stacks when the PID file is corrupt (treated as no daemon)", async () => {
    writeFileSync(join(home, "daemon.pid"), "not-a-number\n", "utf8");
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    await writeSnapshot({
      stack_id: "corrupt-pid",
      worktree_name: "corrupt",
      worktree_path: home,
      status: "stopped",
      started_at: new Date().toISOString(),
      services: [],
    });

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(existsSync(stackDir("corrupt-pid"))).toBe(false);

    expect(sink.text()).not.toMatch(/^warning:/m);
  });
});
