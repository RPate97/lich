/**
 * Unit tests for the daemon auto-start trigger in `lich up` (LEV-411,
 * Plan 5 Task 9).
 *
 * Strategy: mock the `daemon/auto-start.ts` module so `runUp` doesn't
 * actually spawn a daemon binary. The spy captures the call args (so we
 * can assert `openBrowser` reflects the `noBrowser` input flag, and that
 * `lichHome` + `proxyPort` are threaded correctly) and lets each test
 * pick the return shape it needs (already-running vs fresh-spawn vs
 * throw). A minimal yaml under a tmpdir-scoped `LICH_HOME` drives the
 * pipeline end-to-end up to (but not including) any real network or
 * filesystem cost — we don't need a real daemon to verify wiring.
 *
 * Coverage (mirrors the LEV-411 acceptance criteria):
 *   1. `runUp` with default opts calls `ensureDaemonRunning({ openBrowser:
 *      true })` after the stack flips to `up`.
 *   2. `runUp` with `noBrowser: true` calls with `openBrowser: false`.
 *   3. `runUp` failure (any step before status:up) does NOT call
 *      `ensureDaemonRunning`.
 *   4. `ensureDaemonRunning` throwing/rejecting does NOT fail `runUp` —
 *      the exit code stays 0 and a warning lands on the output stream.
 *   5. The pretty output stream shows "Dashboard: <url>" after success.
 *   6. Already-running daemon → "(daemon was already running)" suffix.
 *   7. `config.runtime.proxy_port` is forwarded as `proxyPort` to the hook;
 *      omitted when the yaml doesn't pin it.
 *
 * The mock is hoisted by vitest above the `runUp` import so the
 * `import { ensureDaemonRunning }` inside `commands/up.ts` resolves to
 * the fake. This is the same pattern `up-router.test.ts` uses for the
 * runUp mock in the upHandler routing tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Hoisted mock — vitest moves vi.mock above the import of the SUT. The
// implementation per-test is swapped via `mockImplementation` so each
// case can assert against a different return shape (already-running,
// fresh spawn, throw).
const ensureDaemonRunningSpy = vi.fn(async () => ({
  url: "http://127.0.0.1:54321",
  alreadyRunning: false,
}));
vi.mock("../../../src/daemon/auto-start.js", () => ({
  ensureDaemonRunning: (
    ...args: Parameters<typeof ensureDaemonRunningSpy>
  ) => ensureDaemonRunningSpy(...args),
}));

// Imports MUST come after vi.mock so the mock substitution takes effect.
// eslint-disable-next-line import/first
import { runUp } from "../../../src/commands/up.js";
// eslint-disable-next-line import/first
import { release } from "../../../src/ports/allocator.js";
// eslint-disable-next-line import/first
import { detectWorktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Per-test isolation harness — mirrors `up-routing.test.ts`'s pattern.
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-daemon-trigger-home-"));
  // `stack-` prefix makes worktree-name assertions predictable without
  // having to pin the random suffix.
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  // Reset the mock for each test — no .mockReset() because that would
  // strip the default implementation. mockClear keeps the impl, drops
  // the call history.
  ensureDaemonRunningSpy.mockClear();
  ensureDaemonRunningSpy.mockImplementation(async () => ({
    url: "http://127.0.0.1:54321",
    alreadyRunning: false,
  }));
});

afterEach(async () => {
  // Release any port allocations the orchestrator created so the
  // shared port registry stays clean between tests. The tmpdir
  // teardown would eventually GC LICH_HOME, but this is what `lich
  // down` would do for real.
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
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

/**
 * Minimal-but-real yaml for the trigger tests — one owned service that
 * becomes ready via `log_match: "READY"`, sleeps for 30s (so the process
 * stays alive past the `runUp` return). No ports needed; the daemon
 * trigger doesn't read routing, so we can keep the fixture small. The
 * port range is pinned to a tiny window so the allocator doesn't fight
 * with other test files' allocations across the suite.
 */
function writeMinimalYaml(): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21100, 21120]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
`);
}

/**
 * Yaml that additionally pins `runtime.proxy_port` so we can assert the
 * trigger forwards it as the hook's `proxyPort` argument.
 */
function writeYamlWithProxyPort(port: number): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21130, 21150]
  proxy_port: ${port}
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
`);
}

/**
 * Yaml with a deliberately broken `cmd` that exits non-zero before it
 * can become ready. Drives the "runUp fails → no daemon trigger" test.
 */
function writeFailingYaml(): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21160, 21180]
owned:
  svc:
    cmd: "exit 1"
    ready_when:
      log_match: "NEVER"
      timeout: 500ms
`);
}

/**
 * Capture-friendly stream + accessor. We collect chunks as they're
 * written and concatenate them on demand. PassThrough is enough because
 * the output renderers all write synchronously to the stream.
 */
function captureOut(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

// ---------------------------------------------------------------------------
// 1. Default opts → ensureDaemonRunning called with openBrowser: true
// ---------------------------------------------------------------------------

describe("runUp — daemon trigger fired after status:up (LEV-411)", () => {
  it("calls ensureDaemonRunning with openBrowser: true by default", async () => {
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      openBrowser?: boolean;
      lichHome?: string;
    };
    expect(callArgs.openBrowser).toBe(true);
    // LICH_HOME from process.env (set in beforeEach) propagates so the
    // (mocked) hook would point at the test tmpdir, not ~/.lich.
    expect(callArgs.lichHome).toBe(homeDir);
  });

  it("noBrowser: true → openBrowser: false in the hook call", async () => {
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
      noBrowser: true,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      openBrowser?: boolean;
    };
    expect(callArgs.openBrowser).toBe(false);
  });

  it("noBrowser: false explicit → openBrowser: true (same as default)", async () => {
    // Pin the explicit-false path so a future refactor that swaps the
    // default doesn't silently flip behavior. `noBrowser: false` is the
    // same shape the bin layer produces when `--no-browser` is absent.
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
      noBrowser: false,
    });

    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      openBrowser?: boolean;
    };
    expect(callArgs.openBrowser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Trigger ordering: only fires when the stack actually reaches `up`
// ---------------------------------------------------------------------------

describe("runUp — daemon trigger skipped on failure paths", () => {
  it("does NOT call ensureDaemonRunning when the up fails before status:up", async () => {
    // The service's cmd `exit 1` makes ready never match (and the
    // ProcessExitWatcher races in to fail the up). The daemon trigger
    // sits AFTER the status:up snapshot write, so a pre-up failure must
    // skip it entirely — the dashboard for a broken stack would be
    // misleading.
    writeFailingYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    // Non-zero exit confirms the up failed.
    expect(result.exitCode).not.toBe(0);
    // The trigger sits after the success-path snapshot write — it
    // should never run for a failed up.
    expect(ensureDaemonRunningSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Daemon failure is non-fatal — runUp exits 0 anyway
// ---------------------------------------------------------------------------

describe("runUp — daemon trigger failure is non-fatal", () => {
  it("ensureDaemonRunning throwing does NOT fail runUp (exit code stays 0)", async () => {
    // The stack is up; failing the up here would mislead the user about
    // what actually broke (the daemon, not the services). Pin that a
    // rejecting hook becomes a warning, not an error.
    ensureDaemonRunningSpy.mockImplementation(async () => {
      throw new Error("simulated: lich-daemon binary not found");
    });
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    // Warning lands on the output stream so the user knows why the
    // dashboard isn't reachable, even though the stack is up.
    const out = text();
    expect(out).toMatch(/daemon auto-start failed/);
    expect(out).toMatch(/simulated: lich-daemon binary not found/);
  });

  it("ensureDaemonRunning rejecting on timeout is also tolerated", async () => {
    // Same contract as the binary-not-found case — any rejection from
    // the hook gets caught. Realistic timeout-style failure shape.
    ensureDaemonRunningSpy.mockImplementation(async () => {
      throw new Error(
        "timeout waiting for lich daemon URL file in /tmp/lich after 10000ms",
      );
    });
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(text()).toMatch(/daemon auto-start failed/);
  });
});

// ---------------------------------------------------------------------------
// 4. Output: "Dashboard: <url>" line + already-running suffix
// ---------------------------------------------------------------------------

describe("runUp — Dashboard URL surfaced in output", () => {
  // LEV-481: the dashboard line now prints the friendly apex URL
  // (`http://lich.localhost:<proxy-port>/`) rather than the ephemeral
  // `http://127.0.0.1:<random>` returned by `ensureDaemonRunning`. The
  // daemon registers a static proxy route from the apex to its real
  // dashboard URL, so the user-facing URL is stable across daemon
  // restarts and matches the rest of the friendly-URL convention.
  // `ensureDaemonRunningSpy` still returns the raw URL (used for side
  // effects like browser-open), but the displayed line uses the apex.
  it("pretty output contains 'Dashboard: http://lich.localhost:<proxy-port>/' after a successful up", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:12345",
      alreadyRunning: false,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const out = text();
    // The URL line is the user-facing handoff to the dashboard, so it
    // MUST appear verbatim in the pretty output. No proxy port pinned
    // in the yaml → default 3300.
    expect(out).toMatch(/Dashboard: http:\/\/lich\.localhost:3300\//);
    // The ephemeral 127.0.0.1 URL the daemon binds on is NOT shown.
    expect(out).not.toMatch(/127\.0\.0\.1:12345/);
    // Fresh-spawn path → no "(daemon was already running)" suffix.
    expect(out).not.toMatch(/daemon was already running/);
  });

  it("alreadyRunning: true adds the '(daemon was already running)' suffix", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:54321",
      alreadyRunning: true,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const out = text();
    expect(out).toMatch(
      /Dashboard: http:\/\/lich\.localhost:3300\/ \(daemon was already running\)/,
    );
  });

  it("uses runtime.proxy_port in the friendly dashboard URL when pinned", async () => {
    // LEV-481: the displayed dashboard URL substitutes the resolved
    // proxy port. A pinned `runtime.proxy_port` should appear verbatim
    // so the user can copy/paste the URL straight into a browser tab.
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:12345",
      alreadyRunning: false,
    }));
    writeYamlWithProxyPort(34567);
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(text()).toMatch(/Dashboard: http:\/\/lich\.localhost:34567\//);
  });

  it("json output emits an info event carrying the friendly dashboard URL", async () => {
    // The trigger uses `output.info(...)`, which json mode turns into a
    // `{ type: "info", message: ... }` NDJSON line. Asserting the JSON
    // shape pins the wire contract for scripted callers.
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:8000",
      alreadyRunning: false,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const lines = text().split("\n").filter((l) => l.length > 0);
    const infoEvents = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; message?: string };
        } catch {
          return { type: undefined } as { type?: string; message?: string };
        }
      })
      .filter((e) => e.type === "info");
    const dashboardInfo = infoEvents.find((e) =>
      typeof e.message === "string" && e.message.startsWith("Dashboard:"),
    );
    expect(dashboardInfo).toBeDefined();
    expect(dashboardInfo!.message).toBe(
      "Dashboard: http://lich.localhost:3300/",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. proxy_port forwarding
// ---------------------------------------------------------------------------

describe("runUp — config.runtime.proxy_port forwarding", () => {
  it("forwards runtime.proxy_port as `proxyPort` to ensureDaemonRunning", async () => {
    writeYamlWithProxyPort(33001);
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      proxyPort?: number;
    };
    expect(callArgs.proxyPort).toBe(33001);
  });

  it("omits proxyPort when runtime.proxy_port is unset", async () => {
    // Default-proxy-port behavior lives in the daemon itself + the
    // ensureDaemonRunning hook — the trigger doesn't synthesize 3300
    // up front. Pin that the call arg is omitted (not 3300) so the
    // daemon's default-resolution stays the single source of truth.
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      proxyPort?: number;
    };
    expect(callArgs.proxyPort).toBeUndefined();
  });
});
