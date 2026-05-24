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

// ---------------------------------------------------------------------------
// stop_cmd for oneshot owned services (LEV-309)
//
// `lich up` of a oneshot service spawns its `cmd`, watches it exit cleanly,
// and never tracks any docker containers the cmd launched. `lich nuke`'s
// pre-LEV-309 PID-based teardown therefore couldn't clean those resources —
// SIGTERM on a dead pid is a no-op. The fix re-parses lich.yaml from
// `snapshot.worktree_path` to recover `stop_cmd` and invokes it. These tests
// verify the new path and that the fallback (no yaml / no stop_cmd) keeps
// the old PID-only behavior intact.
// ---------------------------------------------------------------------------

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Make a fresh project dir under the test home and seed a lich.yaml. The
 * worktree path is what nuke re-parses to recover stop_cmd; everything
 * else (state dir, ports, compose) is keyed off the stack id and lives
 * under LICH_HOME so it cleans up with `home` automatically.
 */
function makeProjectDir(name: string, yamlBody: string): string {
  const projectDir = join(home, `project-${name}`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "lich.yaml"), yamlBody, "utf8");
  return projectDir;
}

describe("runNuke — owned stop_cmd (LEV-309)", () => {
  it("invokes stop_cmd for a oneshot owned service whose PID is already dead", async () => {
    // The sentinel proves stop_cmd actually ran. We use a project dir
    // separate from `home` (the LICH_HOME root) so the lich.yaml on disk
    // is what `parseConfig` will see.
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
            // Oneshot: lich-spawned pid has long since exited. Snapshot
            // records the pid that was used at startup; nuke shouldn't
            // depend on it being alive.
            name: "supabase",
            kind: "owned",
            state: "stopped",
            // Use a pid we expect to be dead so the existing kill path
            // is a no-op and we can be certain the sentinel came from
            // the stop_cmd, not from any SIGTERM-handler magic.
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

    // The smoking gun: stop_cmd touched the sentinel.
    expect(existsSync(join(home, "supabase.stopped"))).toBe(true);

    // Plus the existing teardown still ran.
    expect(existsSync(stackDir("oneshot-abc12345"))).toBe(false);
  });

  it("logs a warning and continues when lich.yaml is missing at worktree_path", async () => {
    // worktree_path points at a real directory but with no lich.yaml in it.
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
    // Teardown still completes — warning, not abort.
    expect(result.outcomes[0].status).toBe("nuked");
    expect(result.outcomes[0].detail).toMatch(/parse lich.yaml/);
    expect(result.outcomes[0].detail).toMatch(/not found/);
    expect(existsSync(stackDir("missing-yaml"))).toBe(false);
  });

  it("logs a warning and continues when lich.yaml is invalid", async () => {
    // Schema-invalid yaml — missing required `version`. parseConfig returns
    // { ok: false, errors: [...] }; we should log a warning, NOT abort.
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
    // Warning surfaced in detail; specifically mentions stop_cmd + exit code.
    expect(result.outcomes[0].detail).toMatch(/flaky/);
    expect(result.outcomes[0].detail).toMatch(/stop_cmd/);
    expect(result.outcomes[0].detail).toMatch(/7/);

    // Subsequent teardown steps still happened: compose down attempted,
    // state dir removed.
    const composeDownCall = composeCalls.find((c) =>
      c.args.includes("down"),
    );
    expect(composeDownCall).toBeDefined();
    expect(existsSync(stackDir("stop-fails-abc12345"))).toBe(false);
  });

  it("does NOT spawn stop_cmd for services without one (regression for LEV-295)", async () => {
    // Owned service with no stop_cmd — the only teardown path is the
    // existing PID-based kill. We assert that no stop_cmd sentinel was
    // written for sibling services in the yaml.
    const projectDir = makeProjectDir(
      "no-stop-cmd",
      `version: "1"
owned:
  longlived:
    cmd: "sleep 60"
`,
    );

    // Spawn a real child so we can verify SIGTERM still happens.
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

      // Wait for child to be reaped.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

      // The child must have been killed — PID-based path still works.
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);

      // Detail should NOT mention any stop_cmd warnings (none configured).
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
    // The yaml only declares `kept`, but the snapshot includes both `kept`
    // and `removed`. nuke must not crash; the removed service has no
    // stop_cmd to invoke (we don't know its definition anymore) so it
    // falls through to the existing PID-only teardown.
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
    // stop_cmd for `kept` ran; `removed` was silently skipped (no
    // definition to consult, no panic).
    expect(existsSync(join(home, "kept.stopped"))).toBe(true);
    expect(existsSync(stackDir("drifted-abc12345"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (LEV-309 acceptance criterion)
// ---------------------------------------------------------------------------

describe("runNuke — idempotency", () => {
  it("re-running against an already-clean machine prints 'no stacks to nuke' and exits 0", async () => {
    // First run: nuke a real stack.
    await writeSnapshot(
      snap({
        stack_id: "first-run-abc12345",
        worktree_name: "first-run",
      }),
    );
    const first = await runNuke({ out: makeSink().out, yes: true });
    expect(first.exitCode).toBe(0);
    expect(first.outcomes).toHaveLength(1);

    // Second run: nothing to do.
    const { sink, out } = makeSink();
    const second = await runNuke({ out, yes: true });
    expect(second.exitCode).toBe(0);
    expect(second.outcomes).toEqual([]);
    expect(sink.text()).toContain("no stacks to nuke");
  });
});
