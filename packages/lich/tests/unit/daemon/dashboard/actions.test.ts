import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLichAction,
  type ActionResult,
} from "../../../../src/daemon/dashboard/actions.js";
import {
  startDashboardServer,
  type DashboardServer,
} from "../../../../src/daemon/dashboard/server.js";

let binDir: string;
let workDir: string;
let stateRoot: string;
let fakeLichPath: string;
let prevLichBin: string | undefined;
let server: DashboardServer | null = null;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "lich-actions-bin-"));
  workDir = mkdtempSync(join(tmpdir(), "lich-actions-work-"));
  stateRoot = mkdtempSync(join(tmpdir(), "lich-actions-state-"));
  fakeLichPath = join(binDir, "lich");
  prevLichBin = process.env.LICH_BIN;
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (prevLichBin === undefined) {
    delete process.env.LICH_BIN;
  } else {
    process.env.LICH_BIN = prevLichBin;
  }
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function installFakeLich(body?: string): void {
  const script =
    body ??
    [
      "#!/bin/sh",
      'echo "fake lich invoked with: $1"',
      'echo "cwd: $(pwd)"',
      "exit 0",
    ].join("\n");
  writeFileSync(fakeLichPath, script + "\n", "utf8");
  chmodSync(fakeLichPath, 0o755);
  process.env.LICH_BIN = fakeLichPath;
}

function writeStateJson(
  stackId: string,
  data: Record<string, unknown>,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

function url(path: string): string {
  if (!server) throw new Error("server not started");
  return server.url + path;
}

describe("runLichAction — successful subprocess", () => {
  it("returns ok: true when the subprocess exits 0", async () => {
    installFakeLich();

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake lich invoked with: down");
    expect(result.stderr).toBe("");
  });
});

describe("runLichAction — failing subprocess", () => {
  it("returns ok: false with the exit code when subprocess exits non-zero", async () => {
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "starting down" >&2',
        "exit 7",
      ].join("\n"),
    );

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("starting down");
  });

  it("preserves stdout from a failing subprocess (partial output)", async () => {
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "partial-stdout-line"',
        'echo "error-on-stderr" >&2',
        "exit 1",
      ].join("\n"),
    );

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("partial-stdout-line");
    expect(result.stderr).toContain("error-on-stderr");
  });
});

describe("runLichAction — stdout/stderr capture", () => {
  it("captures interleaved stdout and stderr separately", async () => {
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "out-1"',
        'echo "err-1" >&2',
        'echo "out-2"',
        'echo "err-2" >&2',
        "exit 0",
      ].join("\n"),
    );

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("out-1");
    expect(result.stdout).toContain("out-2");
    expect(result.stderr).toContain("err-1");
    expect(result.stderr).toContain("err-2");
    expect(result.stdout).not.toContain("err-1");
    expect(result.stderr).not.toContain("out-1");
  });

  it("truncates stdout that exceeds the cap", async () => {
    // ~32KB output, well past the 16KB cap; 512-byte lines x 64
    installFakeLich(
      [
        "#!/bin/sh",
        "i=0",
        "while [ $i -lt 64 ]; do",
        '  printf "%s\\n" "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        "  i=$((i + 1))",
        "done",
        "exit 0",
      ].join("\n"),
    );

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("[... output truncated]");
    expect(result.stdout.length).toBeLessThan(17 * 1024);
  });
});

describe("runLichAction — timeout", () => {
  it("kills the subprocess and returns a structured failure on timeout", async () => {
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "starting long task"',
        "sleep 30",
        "exit 0",
      ].join("\n"),
    );

    const start = Date.now();
    const result = await runLichAction(workDir, "down", { timeoutMs: 200 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out after");
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("runLichAction — cwd propagation", () => {
  it("spawns the subprocess in the given worktree path", async () => {
    installFakeLich();

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/cwd: .+/);
  });
});

describe("runLichAction — binary resolution", () => {
  it("throws when LICH_BIN points at a missing path", async () => {
    process.env.LICH_BIN = join(binDir, "does-not-exist");

    await expect(runLichAction(workDir, "down")).rejects.toThrow(
      /lich binary not found at .*does-not-exist/,
    );
  });
});

describe("dashboard server — POST /api/stacks/:id/stop", () => {
  it("returns 200 with ActionResult JSON when the stack exists", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      runAction: async (
        _wp: string,
        _action: "down" | "restart",
      ): Promise<ActionResult> => ({
        ok: true,
        exitCode: 0,
        stdout: "down completed",
        stderr: "",
      }),
    });

    const res = await fetch(url("/api/stacks/stack-1/stop"), {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "down completed",
      stderr: "",
    });
  });

  it("calls runAction with action='down' and the snapshot's worktree_path", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    let capturedArgs: { worktreePath: string; action: string } | null = null;
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      runAction: async (worktreePath: string, action: "down" | "restart") => {
        capturedArgs = { worktreePath, action };
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await fetch(url("/api/stacks/stack-1/stop"), { method: "POST" });

    expect(capturedArgs).toEqual({
      worktreePath: workDir,
      action: "down",
    });
  });

  it("returns 404 for an unknown stack id", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/nonexistent/stop"), {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 405 for GET (the route is POST-only)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/stack-1/stop"));

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 200 with ok:false when the action ran but the CLI exited non-zero", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      runAction: async () => ({
        ok: false,
        exitCode: 5,
        stdout: "started, then failed",
        stderr: "teardown error",
      }),
    });

    const res = await fetch(url("/api/stacks/stack-1/stop"), {
      method: "POST",
    });

    // 200 (not 500) so the UI can render structured failure detail
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      exitCode: 5,
      stdout: "started, then failed",
      stderr: "teardown error",
    });
  });

  it("returns 500 when runAction throws (hard config error)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      runAction: async () => {
        throw new Error("lich binary not found at /opt/missing");
      },
    });

    const res = await fetch(url("/api/stacks/stack-1/stop"), {
      method: "POST",
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_server_error");
    expect(body.message).toContain("lich binary not found");
  });
});

describe("dashboard server — POST /api/stacks/:id/restart", () => {
  it("calls runAction with action='restart'", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    let capturedArgs: { worktreePath: string; action: string } | null = null;
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      runAction: async (worktreePath: string, action: "down" | "restart") => {
        capturedArgs = { worktreePath, action };
        return {
          ok: true,
          exitCode: 0,
          stdout: "restart completed",
          stderr: "",
        };
      },
    });

    const res = await fetch(url("/api/stacks/stack-1/restart"), {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(capturedArgs).toEqual({
      worktreePath: workDir,
      action: "restart",
    });

    const body = await res.json();
    expect(body.stdout).toBe("restart completed");
  });

  it("returns 404 for an unknown stack id", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/nonexistent/restart"), {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});

describe("dashboard server + real runLichAction integration", () => {
  it("POST /stop end-to-end spawns the lich binary with action=down", async () => {
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "running: $1"',
        'echo "cwd-marker: $(pwd)"',
        "exit 0",
      ].join("\n"),
    );

    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: workDir,
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/stack-1/stop"), {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionResult;
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain("running: down");
    expect(body.stdout).toContain("cwd-marker:");
  });
});
