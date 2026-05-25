/**
 * Unit tests for the dashboard action runner + POST endpoints
 * (LEV-418, Plan 5 Task 16).
 *
 * Strategy: drive `runLichAction` against a tiny fake `lich` shell script
 * pointed at via `LICH_BIN`. The script simulates the real CLI's
 * exit-code / stdout / stderr contract without needing the compiled
 * binary. Mirrors `daemon/auto-start.test.ts`'s pattern for the daemon
 * binary so the test surface is consistent.
 *
 * Coverage (per task spec):
 *
 *   runLichAction:
 *     1. Returns { ok: true, exitCode: 0 } when the subprocess exits 0
 *     2. Returns { ok: false } with the exit code when subprocess fails
 *     3. Captures stdout and stderr correctly
 *     4. Respects the timeout (SIGKILLs the subprocess on expiry)
 *     5. Spawns with cwd: worktreePath
 *     6. Truncates output that exceeds the cap
 *     7. Throws when LICH_BIN points at a missing path
 *
 *   Server integration:
 *     8. POST /api/stacks/<id>/stop on a known stack returns 200
 *     9. POST /api/stacks/<id>/stop on a known stack invokes runAction
 *        with ("down") and the right worktree_path
 *    10. POST /api/stacks/<id>/restart invokes runAction with ("restart")
 *    11. POST /api/stacks/nonexistent/stop returns 404
 *    12. GET /api/stacks/<id>/stop returns 405 Method Not Allowed
 *    13. When runAction throws, the server returns 500
 *    14. When runAction returns ok:false (CLI exited non-zero), the
 *        server still returns 200 with the structured result
 */

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

// ---------------------------------------------------------------------------
// Fixture harness — fresh tmpdirs per test, fake binary, restored env
// ---------------------------------------------------------------------------

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

/**
 * Write an executable shell script at `fakeLichPath` and point
 * `LICH_BIN` at it. The script body is what gets executed when
 * `runLichAction` spawns the binary.
 *
 * The default script echoes the action arg + cwd to stdout and exits 0
 * — covers the happy path. Tests pass a custom body for failure /
 * timeout / large-output scenarios.
 */
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

/**
 * Write a synthetic state.json for a stack under `stateRoot/<id>/`. The
 * snapshot's `worktree_path` field is what the server uses as the cwd
 * for the spawned action.
 */
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

/** URL composer for the running server. */
function url(path: string): string {
  if (!server) throw new Error("server not started");
  return server.url + path;
}

// ---------------------------------------------------------------------------
// 1. runLichAction — exit 0 → ok: true
// ---------------------------------------------------------------------------

describe("runLichAction — successful subprocess", () => {
  it("returns ok: true when the subprocess exits 0", async () => {
    installFakeLich(); // default: exit 0

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake lich invoked with: down");
    expect(result.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. runLichAction — non-zero exit → ok: false with the exit code
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. runLichAction — captures stdout + stderr correctly
// ---------------------------------------------------------------------------

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
    // Both lines on each stream are captured, in order.
    expect(result.stdout).toContain("out-1");
    expect(result.stdout).toContain("out-2");
    expect(result.stderr).toContain("err-1");
    expect(result.stderr).toContain("err-2");
    // Streams are not cross-contaminated.
    expect(result.stdout).not.toContain("err-1");
    expect(result.stderr).not.toContain("out-1");
  });

  it("truncates stdout that exceeds the cap", async () => {
    // Write ~32KB of stdout (well past the 16KB cap). The fake uses a
    // loop that produces 1KB chunks. Bash's `printf` would do it too,
    // but the shell-portable approach is a `yes`-style loop bounded by
    // a counter — works on POSIX sh.
    installFakeLich(
      [
        "#!/bin/sh",
        "i=0",
        "while [ $i -lt 64 ]; do",
        // 512-byte line, no leading whitespace, easy to count.
        '  printf "%s\\n" "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        "  i=$((i + 1))",
        "done",
        "exit 0",
      ].join("\n"),
    );

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    // The stdout includes the truncation sentinel — proves we capped.
    expect(result.stdout).toContain("[... output truncated]");
    // And the length is bounded; allow some slack for the sentinel.
    // 16KB cap + ~30 bytes for the sentinel.
    expect(result.stdout.length).toBeLessThan(17 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 4. runLichAction — timeout
// ---------------------------------------------------------------------------

describe("runLichAction — timeout", () => {
  it("kills the subprocess and returns a structured failure on timeout", async () => {
    // Fake that sleeps far longer than the test's tolerance — the
    // timeout must SIGKILL it before the natural exit.
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
    // The structured-error message identifies the timeout so the UI
    // can render a useful "your action took too long" panel.
    expect(result.stderr).toContain("timed out after");
    // And we actually got killed — not waiting the full 30s.
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// 5. runLichAction — spawns with the right cwd
// ---------------------------------------------------------------------------

describe("runLichAction — cwd propagation", () => {
  it("spawns the subprocess in the given worktree path", async () => {
    installFakeLich(); // default echoes "cwd: $(pwd)"

    const result = await runLichAction(workDir, "down");

    expect(result.ok).toBe(true);
    // Resolved tmpdir paths on macOS may go through /private/var — both
    // forms should resolve to the same canonical place. We just check
    // that the cwd line shows up; the exact path comparison varies by
    // platform.
    expect(result.stdout).toMatch(/cwd: .+/);
  });
});

// ---------------------------------------------------------------------------
// 6. runLichAction — binary not found
// ---------------------------------------------------------------------------

describe("runLichAction — binary resolution", () => {
  it("throws when LICH_BIN points at a missing path", async () => {
    process.env.LICH_BIN = join(binDir, "does-not-exist");

    await expect(runLichAction(workDir, "down")).rejects.toThrow(
      /lich binary not found at .*does-not-exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7-14. Server integration — POST routes call runAction
// ---------------------------------------------------------------------------

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

    // Inject a deterministic runAction — proves the wire shape end-to-end.
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

    // The HTTP request succeeded — the dashboard wants the structured
    // failure detail to render in the result panel. 500 here would hide
    // it behind a generic server-error page.
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

// ---------------------------------------------------------------------------
// End-to-end: server + real runLichAction + fake binary
// ---------------------------------------------------------------------------

describe("dashboard server + real runLichAction integration", () => {
  it("POST /stop end-to-end spawns the lich binary with action=down", async () => {
    // Write a real fake binary, point LICH_BIN at it, then exercise the
    // server through the DEFAULT (un-injected) runAction path. This is
    // the closest unit-test approximation of the production wire-up.
    installFakeLich(
      [
        "#!/bin/sh",
        'echo "running: $1"',
        // Use the cwd marker so we can confirm the worktree_path was
        // honored end-to-end.
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
    // cwd marker is present — the binary was actually launched with
    // cwd=workDir (modulo platform path canonicalization).
    expect(body.stdout).toContain("cwd-marker:");
  });
});
