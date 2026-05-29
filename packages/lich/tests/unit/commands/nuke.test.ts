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

let home: string;
let prevLichHome: string | undefined;
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;
let composeCalls: Array<{ cmd: string; args: string[] }>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-nuke-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;

  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";

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
    worktree_path: home,
    status: "stopped",
    started_at: new Date().toISOString(),
    services: [],
    ...overrides,
  };
}

describe("runNuke — empty", () => {
  it("prints 'no stacks to nuke' and exits 0 when no stacks exist", async () => {
    const { sink, out } = makeSink();
    const result = await runNuke({ out });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");
  });
});

describe("runNuke — confirmation prompt", () => {
  it("--yes bypasses the prompt and proceeds", async () => {
    await writeSnapshot(snap({ stack_id: "s1", worktree_name: "s1" }));
    const { sink, out } = makeSink();
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

    expect(existsSync(stackDir("compose-only-abc12345"))).toBe(false);

    // 2 calls: down -v --remove-orphans, then ps -q verification
    expect(composeCalls.length).toBe(2);
    const downCall = composeCalls[0];
    expect(downCall.cmd).toBe("docker");
    expect(downCall.args).toContain("compose");
    expect(downCall.args).toContain("down");
    expect(downCall.args).toContain("-v");
    expect(downCall.args).toContain("--remove-orphans");
    const projectIdx = downCall.args.indexOf("-p");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(downCall.args[projectIdx + 1]).toBe("lich-compose-only-abc12345");

    const psCall = composeCalls[1];
    expect(psCall.cmd).toBe("docker");
    expect(psCall.args).toContain("ps");
    expect(psCall.args).toContain("-q");

    expect(result.outcomes[0].detail ?? "").not.toMatch(/compose down/);
    expect(sink.text()).toMatch(/nuked 1, failed 0, skipped 0/);
  });
});

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

    expect(composeCalls).toHaveLength(0);
  });
});

describe("runNuke — kills owned processes", () => {
  it("SIGTERMs (and reaps) a running owned process via its recorded PID", async () => {
    const child = spawn(
      "node",
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", detached: false },
    );

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

      // wait for kernel reap — process.kill(pid, 0) can see a defunct PID briefly
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);

      expect(existsSync(stackDir("with-pid"))).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("dead/missing PID is a no-op (still records nuked)", async () => {
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

    // first call throws, subsequent calls succeed
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

    expect(existsSync(stackDir("first"))).toBe(false);
    expect(existsSync(stackDir("second"))).toBe(false);

    const first = result.outcomes.find((o) => o.stackId === "first");
    expect(first?.status).toBe("nuked");
    expect(first?.detail).toMatch(/compose down/);

    const second = result.outcomes.find((o) => o.stackId === "second");
    expect(second?.status).toBe("nuked");

    expect(sink.text()).toMatch(/nuked 2, failed 0, skipped 0/);
  });

  it("compose-only stacks where compose CLI cannot be detected are still nuked", async () => {
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

describe("runNuke — compose force-remove", () => {
  it("force-removes a container that compose down left running, then warns", async () => {
    await writeSnapshot(
      snap({
        stack_id: "leaky-abc12345",
        worktree_name: "leaky",
        services: [{ name: "pg", kind: "compose", state: "stopped" }],
      }),
    );

    const leakedId = "leftover-abc123";
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let psCallCount = 0;
    _exec.current = async (cmd, args) => {
      calls.push({ cmd, args });
      let stdout = "";
      if (
        args[args.length - 2] === "ps" &&
        args[args.length - 1] === "-q"
      ) {
        psCallCount++;
        if (psCallCount === 1) stdout = `${leakedId}\n`;
      }
      return { exitCode: 0, stdout, stderr: "" };
    };

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");

    const rmCall = calls.find(
      (c) =>
        c.args[0] === "rm" && c.args[1] === "-f" && c.args[2] === leakedId,
    );
    expect(rmCall).toBeDefined();
    expect(rmCall?.cmd).toBe("docker");

    expect(result.outcomes[0].detail).toBeDefined();
    expect(result.outcomes[0].detail).toMatch(/force-removed/);
    expect(result.outcomes[0].detail).toContain("lich-leaky-abc12345");

    expect(existsSync(stackDir("leaky-abc12345"))).toBe(false);
  });

  it("warns loudly when force-remove also fails to clear the container", async () => {
    await writeSnapshot(
      snap({
        stack_id: "stuck-abc12345",
        worktree_name: "stuck",
        services: [{ name: "pg", kind: "compose", state: "stopped" }],
      }),
    );

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

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");

    expect(result.outcomes[0].detail).toBeDefined();
    expect(result.outcomes[0].detail).toMatch(/could not fully remove/);
    expect(result.outcomes[0].detail).toContain(stuckId);
  });
});

describe("runNuke — stop_cmd stderr surfacing", () => {
  it("includes stop_cmd stderr tail in the warning detail on non-zero exit", async () => {
    const projectDir = makeProjectDir(
      "stop-stderr",
      `version: "1"
owned:
  flaky:
    cmd: "true"
    stop_cmd: "echo failure-detail 1>&2; exit 7"
`,
    );

    await writeSnapshot(
      snap({
        stack_id: "stop-stderr-abc12345",
        worktree_name: "stop-stderr",
        worktree_path: projectDir,
        services: [
          {
            name: "flaky",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_640,
          },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");

    expect(result.outcomes[0].detail).toMatch(/flaky/);
    expect(result.outcomes[0].detail).toMatch(/stop_cmd/);
    expect(result.outcomes[0].detail).toContain("7");
    expect(result.outcomes[0].detail).toContain("failure-detail");

    expect(existsSync(stackDir("stop-stderr-abc12345"))).toBe(false);
  });
});

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function makeProjectDir(name: string, yamlBody: string): string {
  const projectDir = join(home, `project-${name}`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "lich.yaml"), yamlBody, "utf8");
  return projectDir;
}

describe("runNuke — owned stop_cmd", () => {
  it("invokes stop_cmd for a oneshot owned service whose PID is already dead", async () => {
    const projectDir = makeProjectDir(
      "oneshot",
      `version: "1"
owned:
  supabase:
    cmd: "true"
    oneshot: true
    stop_cmd: "touch ${shellQuote(join(home, "supabase.stopped"))}"
`,
    );

    await writeSnapshot(
      snap({
        stack_id: "oneshot-abc12345",
        worktree_name: "oneshot",
        worktree_path: projectDir,
        services: [
          {
            name: "supabase",
            kind: "owned",
            state: "stopped",
            // dead pid so the kill path is no-op; sentinel can only come from stop_cmd
            pid: 2_147_483_641,
          },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");

    expect(existsSync(join(home, "supabase.stopped"))).toBe(true);

    expect(existsSync(stackDir("oneshot-abc12345"))).toBe(false);
  });

  it("logs a warning and continues when lich.yaml is missing at worktree_path", async () => {
    const projectDir = join(home, "missing-yaml-project");
    mkdirSync(projectDir, { recursive: true });

    await writeSnapshot(
      snap({
        stack_id: "missing-yaml",
        worktree_name: "missing-yaml",
        worktree_path: projectDir,
        services: [
          { name: "svc", kind: "owned", state: "stopped", pid: 2_147_483_642 },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.outcomes[0].detail).toMatch(/parse lich.yaml/);
    expect(result.outcomes[0].detail).toMatch(/not found/);
    expect(existsSync(stackDir("missing-yaml"))).toBe(false);
  });

  it("logs a warning and continues when lich.yaml is invalid", async () => {
    const projectDir = makeProjectDir(
      "invalid-yaml",
      `not_a_valid_lich_yaml: oops\n`,
    );

    await writeSnapshot(
      snap({
        stack_id: "invalid-yaml",
        worktree_name: "invalid-yaml",
        worktree_path: projectDir,
        services: [],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.outcomes[0].detail).toMatch(/parse lich.yaml/);
    expect(existsSync(stackDir("invalid-yaml"))).toBe(false);
  });

  it("records a warning but completes when stop_cmd exits non-zero", async () => {
    const projectDir = makeProjectDir(
      "stop-fails",
      `version: "1"
owned:
  flaky:
    cmd: "true"
    stop_cmd: "exit 7"
`,
    );

    await writeSnapshot(
      snap({
        stack_id: "stop-fails-abc12345",
        worktree_name: "stop-fails",
        worktree_path: projectDir,
        services: [
          {
            name: "flaky",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_643,
          },
          // A compose service so we can verify compose down still happens
          // after the stop_cmd warning.
          { name: "pg", kind: "compose", state: "stopped" },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.outcomes[0].detail).toMatch(/flaky/);
    expect(result.outcomes[0].detail).toMatch(/stop_cmd/);
    expect(result.outcomes[0].detail).toMatch(/7/);

    const composeDownCall = composeCalls.find((c) =>
      c.args.includes("down"),
    );
    expect(composeDownCall).toBeDefined();
    expect(existsSync(stackDir("stop-fails-abc12345"))).toBe(false);
  });

  it("does NOT spawn stop_cmd for services without one", async () => {
    const projectDir = makeProjectDir(
      "no-stop-cmd",
      `version: "1"
owned:
  longlived:
    cmd: "sleep 60"
`,
    );

    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: false,
    });
    expect(typeof child.pid).toBe("number");
    const pid = child.pid as number;

    try {
      await writeSnapshot(
        snap({
          stack_id: "no-stop-cmd-abc12345",
          worktree_name: "no-stop-cmd",
          worktree_path: projectDir,
          services: [
            { name: "longlived", kind: "owned", state: "ready", pid },
          ],
        }),
      );

      const { out } = makeSink();
      const result = await runNuke({ out, yes: true });

      expect(result.exitCode).toBe(0);
      expect(result.outcomes[0].status).toBe("nuked");

      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);

      expect(result.outcomes[0].detail ?? "").not.toMatch(/stop_cmd/);

      expect(existsSync(stackDir("no-stop-cmd-abc12345"))).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("skips owned services in the snapshot that no longer exist in the yaml", async () => {
    const projectDir = makeProjectDir(
      "drifted",
      `version: "1"
owned:
  kept:
    cmd: "true"
    stop_cmd: "touch ${shellQuote(join(home, "kept.stopped"))}"
`,
    );

    await writeSnapshot(
      snap({
        stack_id: "drifted-abc12345",
        worktree_name: "drifted",
        worktree_path: projectDir,
        services: [
          {
            name: "kept",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_644,
          },
          {
            // No matching definition in the yaml anymore.
            name: "removed",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_645,
          },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(existsSync(join(home, "kept.stopped"))).toBe(true);
    expect(existsSync(stackDir("drifted-abc12345"))).toBe(false);
  });
});

describe("runNuke — stop_cmd env carries worktree-derived values", () => {
  it("passes SUPABASE_PROJECT_ID resolved from ${worktree.id} into stop_cmd env", async () => {
    const { hashPath, sanitizeName } = await import(
      "../../../src/worktree/detect.js"
    );

    const projectDir = makeProjectDir(
      "supa-leak",
      `version: "1"
owned:
  supabase:
    cmd: "true"
    oneshot: true
    env:
      SUPABASE_PROJECT_ID: "p-\${worktree.id}"
    stop_cmd: "printf '%s' \\"\${SUPABASE_PROJECT_ID}\\" > ${shellQuote(join(home, "supabase.project"))}"
`,
    );

    // mirror nuke's reconstruction via hashPath(worktree_path)
    const expectedId = hashPath(projectDir);
    const expected = `p-${expectedId}`;
    const sanitized = sanitizeName("supa-leak");

    await writeSnapshot(
      snap({
        stack_id: `${sanitized}-${expectedId.slice(0, 8)}`,
        worktree_name: "supa-leak",
        worktree_path: projectDir,
        services: [
          {
            name: "supabase",
            kind: "owned",
            state: "stopped",
            pid: 2_147_483_641,
          },
        ],
      }),
    );

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");

    const sentinelPath = join(home, "supabase.project");
    expect(existsSync(sentinelPath)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinelPath, "utf8")).toBe(expected);
  });
});

describe("runNuke — idempotency", () => {
  it("re-running against an already-clean machine prints 'no stacks to nuke' and exits 0", async () => {
    await writeSnapshot(
      snap({
        stack_id: "first-run-abc12345",
        worktree_name: "first-run",
      }),
    );
    const first = await runNuke({ out: makeSink().out, yes: true });
    expect(first.exitCode).toBe(0);
    expect(first.outcomes).toHaveLength(1);

    const { sink, out } = makeSink();
    const second = await runNuke({ out, yes: true });
    expect(second.exitCode).toBe(0);
    expect(second.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");
  });
});

import { appendStarted } from "../../../src/state/started-log.js";

describe("runNuke --rescue", () => {
  it("invokes stop_cmd with the LOGGED env (NOT process.env)", async () => {
    // empty sentinel → rescue ignored entry.env and used process.env (LEV-310 at recovery)
    const sentinelPath = join(home, "rescue-stop-env.txt");
    const expectedValue = "p-from-resolved-env-not-process-env";

    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "leaked-stack",
      kind: "owned",
      service: "supabase",
      cmd: "supabase start",
      stop_cmd: `printf '%s' "$SUPABASE_PROJECT_ID" > ${shellQuote(sentinelPath)}`,
      cwd: home,
      env: { SUPABASE_PROJECT_ID: expectedValue },
    });

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toBeDefined();
    expect(result.rescue).toHaveLength(1);
    expect(result.rescue![0].kind).toBe("owned");
    expect(result.rescue![0].status).toBe("ok");

    expect(existsSync(sentinelPath)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(sentinelPath, "utf8")).toBe(expectedValue);
  });

  it("is idempotent — re-running finds no new orphans and stays green", async () => {
    const sentinelDir = join(home, "rescue-idempotent");
    mkdirSync(sentinelDir, { recursive: true });

    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "rescue-twice",
      kind: "owned",
      service: "thing",
      cmd: "true",
      stop_cmd: `touch ${shellQuote(join(sentinelDir, "stopped"))}`,
      cwd: sentinelDir,
      env: {},
    });

    const first = await runNuke({ out: makeSink().out, yes: true, rescue: true });
    expect(first.exitCode).toBe(0);
    expect(first.rescue).toHaveLength(1);
    expect(first.rescue![0].status).toBe("ok");

    expect(existsSync(join(sentinelDir, "stopped"))).toBe(true);

    // we don't tombstone; second run sees the same entry, idempotent cleanup
    const { sink, out } = makeSink();
    const second = await runNuke({ out, yes: true, rescue: true });
    expect(second.exitCode).toBe(0);
    expect(second.rescue).toHaveLength(1);
    expect(second.rescue![0].status).toBe("ok");
    expect(sink.text()).toMatch(/Rescue scan/);
  });

  it("reports a dead PID as 'already dead' without error", async () => {
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "ghost-stack",
      kind: "pid",
      service: "ghost",
      pid: 2_147_483_640,
      cmd: "true",
      cwd: home,
    });

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toHaveLength(1);
    expect(result.rescue![0].kind).toBe("pid");
    expect(result.rescue![0].status).toBe("ok");
    expect(result.rescue![0].detail).toMatch(/already dead/);
  });

  it("SIGTERMs a live PID logged in the started log", async () => {
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: false,
    });
    expect(typeof child.pid).toBe("number");
    const pid = child.pid as number;

    try {
      await appendStarted({
        ts: new Date().toISOString(),
        stack_id: "live-pid",
        kind: "pid",
        service: "longlived",
        pid,
        cmd: "node -e ...",
        cwd: home,
      });

      const { out } = makeSink();
      const result = await runNuke({ out, yes: true, rescue: true });

      expect(result.exitCode).toBe(0);
      expect(result.rescue).toHaveLength(1);
      expect(result.rescue![0].kind).toBe("pid");
      expect(result.rescue![0].status).toBe("ok");

      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("invokes compose down for a logged compose entry", async () => {
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "compose-orphan",
      kind: "compose",
      project: "lich-leaked-project",
      files: [join(home, "compose.yaml")],
      cwd: home,
      compose_cli: "docker",
    });

    const { out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toHaveLength(1);
    expect(result.rescue![0].kind).toBe("compose");
    expect(result.rescue![0].status).toBe("ok");

    const downCall = composeCalls.find((c) =>
      c.args.includes("down") && c.args.includes("--remove-orphans"),
    );
    expect(downCall).toBeDefined();
    const projIdx = downCall!.args.indexOf("-p");
    expect(downCall!.args[projIdx + 1]).toBe("lich-leaked-project");
    expect(downCall!.args).toContain("-v");
  });

  it("works even when state.json is gone (the recovery scenario)", async () => {
    const sentinelPath = join(home, "recovery.txt");

    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "wiped-stack",
      kind: "owned",
      service: "leaker",
      cmd: "true",
      stop_cmd: `touch ${shellQuote(sentinelPath)}`,
      cwd: home,
      env: {},
    });

    expect(existsSync(join(home, "stacks"))).toBe(false);

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(result.rescue).toHaveLength(1);
    expect(result.rescue![0].status).toBe("ok");

    expect(existsSync(sentinelPath)).toBe(true);

    // "no stacks to nuke" would be a lie when the log had work to do
    expect(sink.text()).not.toContain("no stacks to nuke");
    expect(sink.text()).toMatch(/Rescue scan/);
  });

  it("handles all three entry kinds in one pass", async () => {
    const sentinel = join(home, "owned.touched");
    await appendStarted({
      ts: new Date(Date.UTC(2026, 4, 24, 3, 0, 0)).toISOString(),
      stack_id: "mixed",
      kind: "pid",
      service: "api",
      pid: 2_147_483_641,
      cmd: "x",
      cwd: home,
    });
    await appendStarted({
      ts: new Date(Date.UTC(2026, 4, 24, 3, 0, 1)).toISOString(),
      stack_id: "mixed",
      kind: "compose",
      project: "lich-mixed",
      files: [join(home, "c.yaml")],
      cwd: home,
      compose_cli: "docker",
    });
    await appendStarted({
      ts: new Date(Date.UTC(2026, 4, 24, 3, 0, 2)).toISOString(),
      stack_id: "mixed",
      kind: "owned",
      service: "svc",
      cmd: "true",
      stop_cmd: `touch ${shellQuote(sentinel)}`,
      cwd: home,
      env: {},
    });

    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toHaveLength(3);
    for (const o of result.rescue!) {
      expect(o.status).toBe("ok");
    }
    expect(existsSync(sentinel)).toBe(true);
    expect(composeCalls.find((c) => c.args.includes("down"))).toBeDefined();
    expect(sink.text()).toMatch(/Rescue scan \(3 entries/);
  });

  it("rescue=false (plain nuke) does NOT read or act on the started log", async () => {
    const sentinel = join(home, "should-not-exist.txt");
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "non-rescue",
      kind: "owned",
      service: "thing",
      cmd: "true",
      stop_cmd: `touch ${shellQuote(sentinel)}`,
      cwd: home,
      env: {},
    });

    const result = await runNuke({ out: makeSink().out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toBeUndefined();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("prints '(nothing to do)' on an empty log", async () => {
    const { sink, out } = makeSink();
    const result = await runNuke({ out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toEqual([]);
    expect(sink.text()).toMatch(/Rescue scan \(0 entries/);
    expect(sink.text()).toMatch(/nothing to do/);
  });

  it("reports owned entry without stop_cmd as ok with 'no stop_cmd' detail", async () => {
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "no-stop",
      kind: "owned",
      service: "x",
      cmd: "true",
      cwd: home,
      env: {},
    });

    const result = await runNuke({ out: makeSink().out, yes: true, rescue: true });

    expect(result.exitCode).toBe(0);
    expect(result.rescue).toHaveLength(1);
    expect(result.rescue![0].status).toBe("ok");
    expect(result.rescue![0].detail).toMatch(/no stop_cmd/);
  });

  it("regression — plain nuke (no rescue) still works end-to-end", async () => {
    await writeSnapshot(snap({ stack_id: "regression", worktree_name: "regression" }));
    const sentinel = join(home, "regression.untouched");
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: "regression",
      kind: "owned",
      service: "x",
      cmd: "true",
      stop_cmd: `touch ${shellQuote(sentinel)}`,
      cwd: home,
      env: {},
    });

    const result = await runNuke({ out: makeSink().out, yes: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.rescue).toBeUndefined();
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(stackDir("regression"))).toBe(false);
  });
});
