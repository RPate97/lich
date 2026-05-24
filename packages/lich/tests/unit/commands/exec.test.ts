/**
 * Unit tests for `lich exec` (LEV-330 / Plan 2 Task 10).
 *
 * Strategy: drive `runExec` directly with `stdio: "pipe"` and an `onSpawn`
 * hook so we can capture the child's stdout/stderr without inheriting the
 * test runner's streams. Each test runs against a fresh tmpdir with a
 * minimal `lich.yaml` so worktree detection + config parse work.
 *
 * We never touch docker, never start a real stack — the env_group resolver
 * works fine against an empty allocated-ports map for any group whose env
 * values don't reference `${owned.X.port}`. Tests that exercise port
 * references would belong in e2e (excluded per task scope).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExec } from "../../../src/commands/exec.js";

// ---------------------------------------------------------------------------
// Per-test isolation: a fresh tmpdir with a minimal lich.yaml.
// ---------------------------------------------------------------------------

let tmp: string;
let prevHome: string | undefined;
let homeDir: string;

beforeEach(() => {
  // realpathSync resolves macOS's /var → /private/var so paths compare cleanly
  // against detectWorktree's output (which itself realpaths).
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lich-exec-")));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), "lich-exec-home-")));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(tmp, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(tmp, "lich.yaml"), body, "utf8");
}

/**
 * Drive runExec against the per-test tmpdir, capturing the child's stdout
 * and stderr through an `onSpawn` hook. Returns the exit result plus the
 * captured streams. Stderr from `runExec` itself (usage errors, parse
 * errors) is captured into `diagnostics`.
 */
async function execCapture(
  argv: string[],
  opts: {
    envGroupName?: string;
    signal?: AbortSignal;
    cwd?: string;
  } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: string;
  child: ChildProcess | null;
}> {
  let stdout = "";
  let stderr = "";
  let diagnostics = "";
  let captured: ChildProcess | null = null;

  const result = await runExec({
    argv,
    envGroupName: opts.envGroupName,
    cwd: opts.cwd ?? tmp,
    signal: opts.signal,
    stdio: "pipe",
    stderr: (s) => {
      diagnostics += s;
    },
    onSpawn: (child) => {
      captured = child;
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
    },
  });

  return { exitCode: result.exitCode, stdout, stderr, diagnostics, child: captured };
}

// ---------------------------------------------------------------------------
// Argv dispatch — single-arg shell-mode vs multi-arg direct-spawn
// ---------------------------------------------------------------------------

describe("runExec — argv dispatch", () => {
  it("runs argv via /bin/sh -c for single-arg form", async () => {
    // Shell expansion ($HOME) only works when sh -c gets the lone string.
    writeYaml(`version: "1"\nenv:\n  GREETING: hello\n`);
    const res = await execCapture(["echo $GREETING"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
  });

  it("runs argv as direct spawn for multi-arg form", async () => {
    // Direct spawn: each token is literal — `$GREETING` does NOT expand,
    // it's passed to echo as a literal argument.
    writeYaml(`version: "1"\nenv:\n  GREETING: hello\n`);
    const res = await execCapture(["echo", "$GREETING"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("$GREETING");
  });

  it("multi-arg form passes meta-chars through literally", async () => {
    // `;` would normally be a shell command separator. Direct spawn means
    // echo sees it as a positional arg.
    writeYaml(`version: "1"\n`);
    const res = await execCapture(["echo", "a;rm -rf /", "b"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("a;rm -rf / b");
  });

  it("multi-arg form runs a real binary directly", async () => {
    // `printenv` is in POSIX and lich's CI environment; the point is to
    // prove `spawn(argv[0], argv.slice(1))` reaches a real binary without
    // shell involvement.
    writeYaml(`version: "1"\nenv:\n  DIRECT_SPAWN_TEST: ok\n`);
    const res = await execCapture(["printenv", "DIRECT_SPAWN_TEST"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Env group loading
// ---------------------------------------------------------------------------

describe("runExec — env group", () => {
  it("loads the stack env group by default", async () => {
    writeYaml(`version: "1"\nenv:\n  THE_VAR: from-stack\n`);
    const res = await execCapture(["printenv THE_VAR"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("from-stack");
  });

  it("--env-group=X loads a different group", async () => {
    // Two groups with different values for the same var name. exec'ing
    // with each override pins which group's env actually reached the child.
    writeYaml(`
version: "1"
env_groups:
  alpha:
    env:
      THE_VAR: from-alpha
  beta:
    env:
      THE_VAR: from-beta
`);
    const a = await execCapture(["printenv THE_VAR"], { envGroupName: "alpha" });
    const b = await execCapture(["printenv THE_VAR"], { envGroupName: "beta" });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout.trim()).toBe("from-alpha");
    expect(b.stdout.trim()).toBe("from-beta");
  });

  it("user group without extends does NOT see stack env", async () => {
    // Isolation test: TOP is in the stack but `tools` doesn't extend stack,
    // so `lich exec --env-group=tools printenv TOP` should see no value.
    writeYaml(`
version: "1"
env:
  TOP: from-stack
env_groups:
  tools:
    env:
      OWN: yes
`);
    const res = await execCapture(["printenv TOP || echo MISSING"], {
      envGroupName: "tools",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("MISSING");
  });

  it("exits 1 when the env-group name does not resolve", async () => {
    writeYaml(`version: "1"\n`);
    const res = await execCapture(["echo hi"], { envGroupName: "no-such" });
    expect(res.exitCode).toBe(1);
    expect(res.diagnostics).toContain('env_group "no-such"');
  });
});

// ---------------------------------------------------------------------------
// Usage + parse failures
// ---------------------------------------------------------------------------

describe("runExec — usage", () => {
  it("exits 2 on empty argv with usage message", async () => {
    writeYaml(`version: "1"\n`);
    const res = await execCapture([]);
    expect(res.exitCode).toBe(2);
    expect(res.diagnostics).toContain("usage: lich exec");
  });

  it("exits 1 when lich.yaml is missing", async () => {
    // No yaml in tmp.
    const res = await execCapture(["echo hi"]);
    expect(res.exitCode).toBe(1);
    expect(res.diagnostics).toContain("lich.yaml not found");
  });

  it("exits 1 when lich.yaml fails to parse", async () => {
    writeYaml(`this is not valid: [yaml at all\n`);
    const res = await execCapture(["echo hi"]);
    expect(res.exitCode).toBe(1);
    // The parse-error formatter renders `<location>: <message>` — assert on
    // the file path appearing in the diagnostics so we know the formatter
    // ran and the user got a useful pointer.
    expect(res.diagnostics).toContain(tmp);
  });
});

// ---------------------------------------------------------------------------
// Exit-code propagation
// ---------------------------------------------------------------------------

describe("runExec — exit codes", () => {
  it("exits with the child's exit code on normal exit", async () => {
    writeYaml(`version: "1"\n`);
    const ok = await execCapture(["exit 0"]);
    expect(ok.exitCode).toBe(0);
    const failed = await execCapture(["exit 7"]);
    expect(failed.exitCode).toBe(7);
  });

  it("exits 127 when the spawned binary does not exist (multi-arg form)", async () => {
    // Direct-spawn form bypasses sh, so a missing binary surfaces as a
    // spawn-level error we translate to 127 (the shell convention).
    // Bun's spawn surfaces this as "Executable not found in $PATH";
    // Node would surface it as ENOENT — assert on the structural
    // properties (exit code + diagnostic mentions the missing binary)
    // rather than the verbatim runtime-specific message.
    writeYaml(`version: "1"\n`);
    const res = await execCapture([
      "this-binary-does-not-exist-zzzz",
      "arg",
    ]);
    expect(res.exitCode).toBe(127);
    expect(res.diagnostics).toContain("this-binary-does-not-exist-zzzz");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("runExec — cancellation via signal", () => {
  it("returns 130 when signal aborts mid-run", async () => {
    writeYaml(`version: "1"\n`);
    const controller = new AbortController();
    // Kick off a long-sleeping child, then abort shortly after spawn so the
    // exit handler resolves with 130.
    const promise = execCapture(["sleep 30"], { signal: controller.signal });
    // Give the child a moment to actually start before we kill it.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const res = await promise;
    expect(res.exitCode).toBe(130);
  });

  it("returns 130 when signal is already aborted at spawn time", async () => {
    writeYaml(`version: "1"\n`);
    const controller = new AbortController();
    controller.abort();
    const res = await execCapture(["sleep 30"], { signal: controller.signal });
    expect(res.exitCode).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// Cwd handling
// ---------------------------------------------------------------------------

describe("runExec — cwd", () => {
  it("runs the child with the worktree path as cwd", async () => {
    // `pwd` reads the current directory; we expect it to match the tmpdir
    // where lich.yaml lives (the worktree root, not the caller's cwd).
    writeYaml(`version: "1"\n`);
    const res = await execCapture(["pwd"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(tmp);
  });
});
