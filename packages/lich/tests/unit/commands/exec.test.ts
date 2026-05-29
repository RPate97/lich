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
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { ensureStackDir } from "../../../src/state/directory.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

let tmp: string;
let prevHome: string | undefined;
let homeDir: string;

beforeEach(() => {
  // realpath resolves macOS's /var → /private/var
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

function writeYaml(body: string): void {
  writeFileSync(join(tmp, "lich.yaml"), body, "utf8");
}

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

describe("runExec — argv dispatch", () => {
  it("runs argv via /bin/sh -c for single-arg form", async () => {
    writeYaml(`version: "1"\nenv:\n  GREETING: hello\n`);
    const res = await execCapture(["echo $GREETING"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
  });

  it("runs argv as direct spawn for multi-arg form", async () => {
    writeYaml(`version: "1"\nenv:\n  GREETING: hello\n`);
    const res = await execCapture(["echo", "$GREETING"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("$GREETING");
  });

  it("multi-arg form passes meta-chars through literally", async () => {
    writeYaml(`version: "1"\n`);
    const res = await execCapture(["echo", "a;rm -rf /", "b"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("a;rm -rf / b");
  });

  it("multi-arg form runs a real binary directly", async () => {
    writeYaml(`version: "1"\nenv:\n  DIRECT_SPAWN_TEST: ok\n`);
    const res = await execCapture(["printenv", "DIRECT_SPAWN_TEST"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
  });
});

describe("runExec — env group", () => {
  it("loads the stack env group by default", async () => {
    writeYaml(`version: "1"\nenv:\n  THE_VAR: from-stack\n`);
    const res = await execCapture(["printenv THE_VAR"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("from-stack");
  });

  it("--env-group=X loads a different group", async () => {
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

  it("top-level env: literals reach the spawned command (LEV-515)", async () => {
    writeYaml(`version: "1"\nenv:\n  CANARY: from-top-level\n  OTHER: also-present\n`);
    const res = await execCapture(["printenv", "CANARY"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("from-top-level");
  });

  it("user group without extends does NOT see stack env", async () => {
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

describe("runExec — usage", () => {
  it("exits 2 on empty argv with usage message", async () => {
    writeYaml(`version: "1"\n`);
    const res = await execCapture([]);
    expect(res.exitCode).toBe(2);
    expect(res.diagnostics).toContain("usage: lich exec");
  });

  it("exits 1 when lich.yaml is missing", async () => {
    const res = await execCapture(["echo hi"]);
    expect(res.exitCode).toBe(1);
    expect(res.diagnostics).toContain("lich.yaml not found");
  });

  it("exits 1 when lich.yaml fails to parse", async () => {
    writeYaml(`this is not valid: [yaml at all\n`);
    const res = await execCapture(["echo hi"]);
    expect(res.exitCode).toBe(1);
    expect(res.diagnostics).toContain(tmp);
  });
});

describe("runExec — exit codes", () => {
  it("exits with the child's exit code on normal exit", async () => {
    writeYaml(`version: "1"\n`);
    const ok = await execCapture(["exit 0"]);
    expect(ok.exitCode).toBe(0);
    const failed = await execCapture(["exit 7"]);
    expect(failed.exitCode).toBe(7);
  });

  it("exits 127 when the spawned binary does not exist (multi-arg form)", async () => {
    // bun's spawn says "Executable not found in $PATH"; node says ENOENT —
    // assert on exit code + missing-binary mention, not the runtime message
    writeYaml(`version: "1"\n`);
    const res = await execCapture([
      "this-binary-does-not-exist-zzzz",
      "arg",
    ]);
    expect(res.exitCode).toBe(127);
    expect(res.diagnostics).toContain("this-binary-does-not-exist-zzzz");
  });
});

describe("runExec — cancellation via signal", () => {
  it("returns 130 when signal aborts mid-run", async () => {
    writeYaml(`version: "1"\n`);
    const controller = new AbortController();
    const promise = execCapture(["sleep 30"], { signal: controller.signal });
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

describe("runExec — cwd", () => {
  it("runs the child with the worktree path as cwd", async () => {
    writeYaml(`version: "1"\n`);
    const res = await execCapture(["pwd"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(tmp);
  });
});

async function seedSnapshot(activeProfile?: string): Promise<void> {
  const wt = detectWorktree(tmp);
  await ensureStackDir(wt.stack_id);
  await writeSnapshot({
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    services: [],
    ...(activeProfile ? { active_profile: activeProfile } : {}),
  });
}

describe("runExec — active_profile from snapshot", () => {
  it("layers profile env over top-level env when snapshot has active_profile", async () => {
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev:env-override:
    env:
      DATABASE_URL: from-profile
`);
    await seedSnapshot("dev:env-override");

    const res = await execCapture(["printenv DATABASE_URL"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("from-profile");
  });

  it("uses only top-level env when snapshot has no active_profile", async () => {
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev:env-override:
    env:
      DATABASE_URL: from-profile
`);
    await seedSnapshot(undefined);

    const res = await execCapture(["printenv DATABASE_URL"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("top");
  });

  it("auto-injects LICH_PROFILE into the spawned cmd's env when a profile is active", async () => {
    writeYaml(`
version: "1"
profiles:
  dev:env-override: {}
`);
    await seedSnapshot("dev:env-override");

    const res = await execCapture(["printenv LICH_PROFILE"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("dev:env-override");
  });

  it("does NOT auto-inject LICH_PROFILE when no profile is active", async () => {
    writeYaml(`
version: "1"
`);
    await seedSnapshot(undefined);

    const res = await execCapture(["printenv LICH_PROFILE || echo MISSING"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("MISSING");
  });

  it("falls back to top-level-only when active_profile in snapshot no longer exists in yaml", async () => {
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev: {}
`);
    await seedSnapshot("dev:env-override");

    const res = await execCapture(["printenv DATABASE_URL"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("top");
  });
});
