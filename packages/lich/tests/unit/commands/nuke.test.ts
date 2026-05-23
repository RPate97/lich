import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { stackDir } from "../../../src/state/directory.js";
import {
  type StackSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";
import { runNuke } from "../../../src/commands/nuke.js";
import { _exec, type ExecFn } from "../../../src/compose/runner.js";
import { _probe } from "../../../src/compose/detect.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test runs against a fresh tmpdir pointed at by LICH_HOME so we can
// seed stacks via writeSnapshot, capture stdout via a sink, and pipe
// synthetic stdin for confirmation prompts.
// ---------------------------------------------------------------------------

let home: string;
let prevLichHome: string | undefined;
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;
let composeCalls: Array<{ cmd: string; args: string[] }>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-nuke-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;

  // Stub the compose CLI probe so detection succeeds without docker on
  // the host. Always pretend docker compose is available.
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

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
  _exec.current = originalExec;
  _probe.current = originalProbe;
});

// ---------------------------------------------------------------------------
// Sink writable for capturing stdout
// ---------------------------------------------------------------------------

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

/** A non-TTY Readable that emits the given lines and then EOFs. */
function ttyStream(input: string, isTTY: boolean): NodeJS.ReadableStream {
  const stream = Readable.from([input]) as Readable & { isTTY?: boolean };
  if (isTTY) {
    Object.defineProperty(stream, "isTTY", {
      value: true,
      configurable: true,
    });
  }
  return stream;
}

function snap(overrides: Partial<StackSnapshot> & { stack_id: string }): StackSnapshot {
  return {
    worktree_name: overrides.stack_id,
    worktree_path: home, // safe cwd: tmpdir always exists
    status: "stopped",
    started_at: new Date().toISOString(),
    services: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("runNuke — empty", () => {
  it("prints 'no stacks to nuke' and exits 0 when no stacks exist", async () => {
    const { sink, out } = makeSink();
    const result = await runNuke({ out });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");
  });
});

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

describe("runNuke — confirmation prompt", () => {
  it("--yes bypasses the prompt and proceeds", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
    // No stdin given — would block if prompted. --yes must skip prompt.
    const result = await runNuke({ out, yes: true });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(sink.text()).not.toContain("Continue?");
    expect(existsSync(stackDir("s1"))).toBe(false);
  });

  it("TTY + 'n' declines → 'aborted', exit 0, stack NOT removed", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
    const stdin = ttyStream("n\n", true);

    const result = await runNuke({ out, in: stdin });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    const text = sink.text();
    expect(text).toContain("will nuke 1 stack(s)");
    expect(text).toContain("Continue?");
    expect(text).toContain("aborted");
    // Stack dir must survive.
    expect(existsSync(stackDir("s1"))).toBe(true);
  });

  it("TTY + 'y' accepts → proceeds with nuke", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
    const stdin = ttyStream("y\n", true);

    const result = await runNuke({ out, in: stdin });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(sink.text()).toContain("Continue?");
    expect(existsSync(stackDir("s1"))).toBe(false);
  });

  it("TTY + EOF (empty input) → 'aborted'", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
    const stdin = ttyStream("", true);

    const result = await runNuke({ out, in: stdin });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(sink.text()).toContain("aborted");
    expect(existsSync(stackDir("s1"))).toBe(true);
  });

  it("non-TTY stdin skips the prompt (treats as scripted)", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
    const stdin = ttyStream("", false);

    const result = await runNuke({ out, in: stdin });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(sink.text()).not.toContain("Continue?");
  });
});

// ---------------------------------------------------------------------------
// Single stack, only compose services, all already stopped
// ---------------------------------------------------------------------------

describe("runNuke — single compose-only stack", () => {
  it("removes the state directory and records 'nuked'", async () => {
    await writeSnapshot(
      snap({
        stack_id: "compose-only-abc12345",
        worktree_name: "compose-only",
        services: [
          { name: "postgres", kind: "compose", state: "stopped" },
        ],
      }),
    );

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].stackId).toBe("compose-only-abc12345");
    expect(result.outcomes[0].status).toBe("nuked");

    // State dir gone.
    expect(existsSync(stackDir("compose-only-abc12345"))).toBe(false);

    // Compose down was attempted with the lich- prefix project name.
    expect(composeCalls.length).toBe(1);
    const call = composeCalls[0];
    expect(call.cmd).toBe("docker");
    expect(call.args).toContain("compose");
    expect(call.args).toContain("down");
    expect(call.args).toContain("-v");
    expect(call.args).toContain("--remove-orphans");
    // Project name uses the lich-<worktree>-<short> convention.
    const projectIdx = call.args.indexOf("-p");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[projectIdx + 1]).toBe("lich-compose-only-abc12345");

    expect(sink.text()).toMatch(/nuked 1, failed 0, skipped 0/);
  });
});

// ---------------------------------------------------------------------------
// Orphan directory (no state.json)
// ---------------------------------------------------------------------------

describe("runNuke — orphan directory", () => {
  it("removes empty stack dir and records 'skipped'", async () => {
    mkdirSync(stackDir("orphan-xyz"), { recursive: true });
    writeFileSync(join(stackDir("orphan-xyz"), "noise.txt"), "leftover", "utf8");

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].stackId).toBe("orphan-xyz");
    expect(result.outcomes[0].status).toBe("skipped");
    expect(existsSync(stackDir("orphan-xyz"))).toBe(false);
    expect(sink.text()).toMatch(/nuked 0, failed 0, skipped 1/);

    // Orphan dirs should NOT invoke compose down.
    expect(composeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Owned process killing (real child process)
// ---------------------------------------------------------------------------

describe("runNuke — kills owned processes", () => {
  it("SIGTERMs (and reaps) a running owned process via its recorded PID", async () => {
    // Spawn a long-lived child that responds to SIGTERM.
    const child = spawn(
      "node",
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", detached: false },
    );

    // Make sure the spawn worked.
    expect(typeof child.pid).toBe("number");
    const pid = child.pid as number;

    try {
      await writeSnapshot(
        snap({
          stack_id: "with-pid",
          worktree_name: "with-pid",
          services: [
            {
              name: "longlived",
              kind: "owned",
              state: "ready",
              pid,
            },
          ],
        }),
      );

      const { out } = makeSink();
      const result = await runNuke({ out, yes: true });

      expect(result.exitCode).toBe(0);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].status).toBe("nuked");

      // Wait briefly for the child to be fully reaped by the kernel.
      // (process.kill(pid, 0) can still see a defunct PID for a tick.)
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

      // Now isAlive must be false.
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);

      expect(existsSync(stackDir("with-pid"))).toBe(false);
    } finally {
      // Belt-and-braces cleanup in case the test failed mid-way.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("dead/missing PID is a no-op (still records nuked)", async () => {
    // Pick a PID that is almost certainly not in use. Maximum 32-bit
    // pid; any reasonable Unix won't have this many processes.
    await writeSnapshot(
      snap({
        stack_id: "dead-pid",
        worktree_name: "dead-pid",
        services: [
          { name: "ghost", kind: "owned", state: "stopped", pid: 2_147_483_640 },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(existsSync(stackDir("dead-pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple stacks
// ---------------------------------------------------------------------------

describe("runNuke — multiple stacks", () => {
  it("processes all stacks and prints accurate summary", async () => {
    await writeSnapshot(snap({ stack_id: "a-stack", worktree_name: "a" }));
    await writeSnapshot(snap({ stack_id: "b-stack", worktree_name: "b" }));
    mkdirSync(stackDir("orphan-stack"), { recursive: true });

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(3);

    const byStatus = (s: string): number =>
      result.outcomes.filter((o) => o.status === s).length;
    expect(byStatus("nuked")).toBe(2);
    expect(byStatus("skipped")).toBe(1);
    expect(byStatus("failed")).toBe(0);

    expect(existsSync(stackDir("a-stack"))).toBe(false);
    expect(existsSync(stackDir("b-stack"))).toBe(false);
    expect(existsSync(stackDir("orphan-stack"))).toBe(false);

    expect(sink.text()).toMatch(/nuked 2, failed 0, skipped 1/);
  });
});

// ---------------------------------------------------------------------------
// Compose-down failure tolerance
// ---------------------------------------------------------------------------

describe("runNuke — compose down failure", () => {
  it("does NOT prevent other stacks from being nuked", async () => {
    await writeSnapshot(
      snap({
        stack_id: "first",
        worktree_name: "first",
        services: [{ name: "pg", kind: "compose", state: "stopped" }],
      }),
    );
    await writeSnapshot(
      snap({
        stack_id: "second",
        worktree_name: "second",
        services: [{ name: "pg", kind: "compose", state: "stopped" }],
      }),
    );

    // Make compose throw for the FIRST call (e.g. binary blew up
    // mid-process), succeed for subsequent calls.
    let callCount = 0;
    _exec.current = async (cmd, args) => {
      composeCalls.push({ cmd, args });
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated compose CLI failure");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(2);

    // Both stacks must have been processed; both state dirs removed.
    expect(existsSync(stackDir("first"))).toBe(false);
    expect(existsSync(stackDir("second"))).toBe(false);

    // First should be 'nuked' with a compose-down warning detail.
    const first = result.outcomes.find((o) => o.stackId === "first");
    expect(first?.status).toBe("nuked");
    expect(first?.detail).toMatch(/compose down/);

    // Second should be cleanly nuked.
    const second = result.outcomes.find((o) => o.stackId === "second");
    expect(second?.status).toBe("nuked");

    expect(sink.text()).toMatch(/nuked 2, failed 0, skipped 0/);
  });

  it("compose-only stacks where compose CLI cannot be detected are still nuked", async () => {
    // Probe returns false for everything → resolveComposeCli throws.
    _probe.current = async () => false;

    await writeSnapshot(
      snap({
        stack_id: "no-cli",
        worktree_name: "no-cli",
        services: [{ name: "pg", kind: "compose", state: "stopped" }],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.outcomes[0].detail).toMatch(/compose down/);
    expect(existsSync(stackDir("no-cli"))).toBe(false);
  });
});
