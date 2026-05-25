/**
 * Unit tests for the daemon main entry — LEV-406 + LEV-414, Plan 5 Tasks 4 + 12.
 *
 * Coverage:
 *   - PID file is written with process.pid on startup
 *   - daemon.url is written after startup and contains a fetchable URL
 *   - GET <daemon.url>/healthz returns 200 (proves dashboard server bound)
 *   - signal.abort() triggers clean shutdown (PID + URL files cleared,
 *     watcher + dashboard + proxy stopped)
 *   - Auto-shutdown fires after N empty ticks when no stacks are present
 *   - Auto-shutdown does NOT fire when a stack with status="up" exists
 *   - Real dashboard + proxy servers bind on startup (replaces the stub
 *     log assertions from the LEV-406 scaffold)
 *   - Watcher onChange triggers BOTH dashboardServer.refresh() and
 *     routingTable.reload() — covered indirectly by writing a new
 *     state.json post-startup and observing both effects
 *   - Concurrent abort calls don't double-cleanup (idempotent)
 *   - Refuses to start when another daemon is already alive
 *   - Stale PID file (dead PID) is overwritten on startup
 *
 * Tests use a tmpdir for LICH_HOME, an ephemeral proxy port (0), and a
 * tiny `shutdownCheckMs` (e.g. 20ms) with `shutdownGraceTicks: 1` so
 * the auto-shutdown path completes in test-friendly time without
 * actually waiting the production 30s grace.
 *
 * This file does real network IO (Bun.serve binds on real ephemeral
 * ports). That's intentional for unit-level: Bun.serve is fast (<10ms
 * to bind + tear down) and the test would be near-meaningless without
 * verifying the actual HTTP surface comes up. The local-only binding
 * (`hostname: "localhost"`) means we never touch any external network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runDaemon } from "../../../src/daemon/daemon.js";
import {
  readDaemonPid,
  readDaemonUrl,
  writeDaemonPid,
} from "../../../src/daemon/pid-file.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test gets a fresh tmpdir to use as LICH_HOME. We do NOT mutate
// process.env.LICH_HOME at the harness level — the daemon mutates it
// internally for the duration of its run and restores on shutdown, so
// each test passes its own `opts.lichHome` and we leave the env alone.
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-daemon-main-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * PID that's overwhelmingly unlikely to be alive on any system. Mirrors
 * the constant from pid-file.test.ts. Used to construct a stale PID
 * file the daemon must overwrite on startup.
 */
const DEAD_PID = 999_999;

/**
 * Capture the daemon's log output into a buffer we can assert against.
 * The PassThrough stream lets the daemon write synchronously while the
 * `chunks` array accumulates everything for later inspection.
 */
function captureLog(): {
  stream: PassThrough;
  output: () => string;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Helper: write a state.json with the given status under
 * `<home>/stacks/<stackId>/`. Used to put a "live" stack in place
 * before starting the daemon so the auto-shutdown path sees it as
 * still alive and doesn't fire.
 */
function writeFakeStack(stackId: string, status: string): void {
  const stackDir = join(home, "stacks", stackId);
  mkdirSync(stackDir, { recursive: true });
  const snapshot = {
    stack_id: stackId,
    worktree_name: "test",
    worktree_path: "/tmp/test",
    status,
    started_at: new Date().toISOString(),
    services: [],
  };
  writeFileSync(
    join(stackDir, "state.json"),
    JSON.stringify(snapshot) + "\n",
    "utf8",
  );
}

/**
 * Drive a daemon run with a generous wall-clock budget. Returns the
 * abort controller so the test can shut down the daemon, plus a
 * promise that resolves with the daemon's exit code.
 *
 * `shutdownCheckMs: 20` + `shutdownGraceTicks: 1` makes auto-shutdown
 * fire after a single ~20ms tick — far below the production ~30s
 * grace, but long enough that a deliberate "stack appears mid-run"
 * test can still race a fake stack into place.
 */
function startDaemon(opts: {
  signal?: AbortSignal;
  out?: NodeJS.WritableStream;
  shutdownCheckMs?: number;
  shutdownGraceTicks?: number;
  proxyPort?: number;
}): Promise<{ exitCode: number }> {
  return runDaemon({
    lichHome: home,
    // Default to ephemeral port (0) so tests don't collide with each
    // other or with a real daemon running on 3300. Tests that need to
    // verify port-specific behavior pass `proxyPort` explicitly.
    proxyPort: opts.proxyPort ?? 0,
    signal: opts.signal,
    out: opts.out,
    shutdownCheckMs: opts.shutdownCheckMs ?? 20,
    shutdownGraceTicks: opts.shutdownGraceTicks ?? 1,
  });
}

// ---------------------------------------------------------------------------
// 1. PID file written with process.pid on startup
// ---------------------------------------------------------------------------

describe("runDaemon — PID file lifecycle", () => {
  it("writes the PID file with process.pid on startup", async () => {
    // Pre-populate a fake "up" stack so the daemon doesn't auto-shut
    // before we can read the PID file. Then abort via the controller
    // once we've verified the file is present.
    writeFakeStack("test-stack-1", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000, // long — we abort manually
      shutdownGraceTicks: 3,
    });

    // Poll the PID file: the daemon's startup is asynchronous (writes
    // happen inside runDaemon's first await), so we wait briefly.
    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    expect(pid).toBe(process.pid);

    // Cleanup — abort the daemon so the test doesn't hang.
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("clears the PID file on clean shutdown via signal.abort", async () => {
    writeFakeStack("test-stack-2", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup to complete (PID file present).
    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    // Abort and wait for shutdown to finish.
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);

    // PID file must be gone after clean shutdown.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(await readDaemonPid({ lichHome: home })).toBeNull();
  });

  it("overwrites a stale PID file (dead PID) on startup", async () => {
    // Pre-write a PID file pointing at a definitely-dead process.
    // Without stale-detect logic the daemon would refuse to start.
    await writeDaemonPid(DEAD_PID, { lichHome: home });
    expect(await readDaemonPid({ lichHome: home })).toBe(DEAD_PID);

    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
    });

    // After startup, the PID file should reflect OUR pid, not the stale
    // one. Poll for it.
    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null && pid !== DEAD_PID) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(pid).toBe(process.pid);

    controller.abort();
    await daemonPromise;
  });

  it("refuses to start when another daemon is already alive (PID = current process)", async () => {
    // Write a PID file with the CURRENT process's pid — that's
    // guaranteed to be alive (we're running this test code). The
    // daemon should detect this and bail out with exit 1.
    await writeDaemonPid(process.pid, { lichHome: home });

    const { stream } = captureLog();
    const result = await runDaemon({
      lichHome: home,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(1);
    // PID file should still point at us (we didn't overwrite it on
    // refuse-to-start — that would break the rightful owner's
    // lifecycle).
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// 2. Signal abort triggers clean shutdown
// ---------------------------------------------------------------------------

describe("runDaemon — signal abort", () => {
  it("shuts down cleanly when signal is aborted", async () => {
    writeFakeStack("test-stack-3", "up");
    const controller = new AbortController();
    const { stream, output } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // Fire abort. The daemon should resolve quickly (well under 1s).
    const abortStart = Date.now();
    controller.abort();
    const result = await daemonPromise;
    const elapsed = Date.now() - abortStart;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(1_000);
    // The "shutdown requested" log line carries our reason.
    expect(output()).toContain("shutdown requested");
  });

  it("handles an already-aborted signal at startup (immediate shutdown)", async () => {
    // Pre-abort the controller before runDaemon even starts. The daemon
    // should detect this and exit cleanly without waiting for ticks.
    const controller = new AbortController();
    controller.abort();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Must resolve fast — < 1s wall clock.
    const start = Date.now();
    const result = await daemonPromise;
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    // PID file cleaned up.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-shutdown when no stacks present
// ---------------------------------------------------------------------------

describe("runDaemon — auto-shutdown", () => {
  it("auto-shuts down when no alive stacks exist", async () => {
    // No state.json files anywhere. With shutdownCheckMs=20 and
    // shutdownGraceTicks=1, the daemon's first tick (after a 20ms
    // delay) should see zero alive stacks and trigger shutdown.
    const { stream, output } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toContain("auto-shutdown");
    // PID file cleared post-shutdown.
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("does NOT auto-shutdown when a stack with status=up exists", async () => {
    writeFakeStack("alive-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    // Let the auto-shutdown tick fire a few times. With graceTicks=1
    // and an alive stack, the empty-tick counter should never increment.
    await new Promise<void>((r) => setTimeout(r, 200));

    // The daemon should STILL be running. Verify by checking the PID
    // file is still present (it would be cleared on shutdown).
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);

    // Cleanup
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("does NOT auto-shutdown when a stack with status=starting exists", async () => {
    // "starting" is in the ALIVE_STATUSES set per the spec — a stack
    // mid-startup should keep the daemon alive.
    writeFakeStack("starting-stack", "starting");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    controller.abort();
    await daemonPromise;
  });

  it("DOES auto-shutdown when only stopped/failed stacks exist", async () => {
    // Stopped and failed stacks are history — they shouldn't keep
    // the daemon alive. With graceTicks=1, the first tick after the
    // initial 20ms delay should fire shutdown.
    writeFakeStack("done-stack", "stopped");
    writeFakeStack("broken-stack", "failed");
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("requires N consecutive empty ticks before shutting down", async () => {
    // With graceTicks=3 the daemon must see 3 empty ticks in a row.
    // We poll the log output to confirm multiple ticks fire before
    // the auto-shutdown actually triggers.
    const { stream, output } = captureLog();

    const start = Date.now();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 30,
      shutdownGraceTicks: 3,
    });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // 3 ticks at 30ms each = ~90ms minimum, plus the initial delay
    // and the first tick's grace. Allow a generous lower bound.
    expect(elapsed).toBeGreaterThan(75);
    expect(output()).toContain("3 empty ticks");
  });
});

// ---------------------------------------------------------------------------
// 4. Real dashboard + proxy server startup (LEV-414, Plan 5 Task 12)
//
// LEV-406 (Task 4) shipped placeholder "would start here" log lines
// where the real `Bun.serve` instances eventually go. LEV-414 swaps in
// the real `startDashboardServer` + `startProxy` calls. These tests
// verify the real surface comes up: daemon.url is written, the
// dashboard's /healthz responds, and the proxy listens on the
// configured port.
// ---------------------------------------------------------------------------

describe("runDaemon — real dashboard + proxy startup", () => {
  it("writes daemon.url with the dashboard URL after startup", async () => {
    // Pre-populate a fake "up" stack so the daemon doesn't auto-shut
    // before we can read the URL file. The URL is written immediately
    // after Bun.serve binds — there's no race window beyond the
    // startup latency itself.
    writeFakeStack("test-stack-url", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Poll for the URL file with the same 2s timeout we use for PID.
    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // URL must be present and shaped like `http://127.0.0.1:<port>`.
    // (LEV-459: the daemon now reports IPv4 explicitly to dodge the
    // `localhost` IPv6-resolution-order bug on macOS.)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("dashboard URL is reachable: GET /healthz returns 200", async () => {
    // Real network IO: we hit the dashboard server's /healthz endpoint
    // via the URL the daemon recorded in daemon.url. This is the
    // observable proof that startDashboardServer() actually bound a
    // port and the handler is wired correctly.
    writeFakeStack("test-stack-healthz", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for the URL file to appear.
    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    // Fetch /healthz directly. A 200 here proves: the dashboard
    // server's `startDashboardServer` actually ran, Bun.serve actually
    // bound, the URL we got is the URL Bun bound on, and the
    // /healthz route returns the expected shape.
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("dashboard exposes primary_url derived from state.json routing entries", async () => {
    // The dashboard's StackView surfaces a `primary_url` synthesized
    // from the snapshot's `routing` array. A successful surface here
    // means the dashboard re-read the snapshot from disk after our
    // pre-startup writeFileSync, which is the same plumbing the
    // watcher uses post-startup.
    const stackDir = join(home, "stacks", "test-routing");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      join(stackDir, "state.json"),
      JSON.stringify({
        stack_id: "test-routing",
        worktree_name: "feature-x",
        worktree_path: "/tmp/wt",
        status: "up",
        started_at: new Date().toISOString(),
        services: [],
        routing: [
          {
            hostname: "api.feature-x",
            upstream_url: "http://127.0.0.1:9123",
            service: "api",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for the URL file (= dashboard bound + URL written).
    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    // /api/stacks reflects the on-disk snapshot.
    const res = await fetch(`${url}/api/stacks`);
    expect(res.status).toBe(200);
    const stacks = (await res.json()) as Array<{
      id: string;
      primary_url?: string;
    }>;
    const found = stacks.find((s) => s.id === "test-routing");
    expect(found).toBeDefined();
    expect(found?.primary_url).toBe("http://127.0.0.1:9123");

    controller.abort();
    await daemonPromise;
  });

  it("watcher onChange triggers BOTH dashboard refresh AND routing reload (post-startup state change)", async () => {
    // Strategy:
    //   1. Start an actual upstream Bun.serve so we have a real port
    //      to route to.
    //   2. Start the daemon (no stacks initially).
    //   3. Post-startup, write a state.json with routing pointing at
    //      the upstream. The watcher fires both:
    //        - dashboardServer.refresh()  →  /api/stacks surfaces the
    //                                         new stack's primary_url
    //        - routingTable.reload()      →  proxy routes the friendly
    //                                         hostname to the upstream
    //   4. Verify both observable effects: GET /api/stacks shows the
    //      new stack with primary_url, AND a Host-headered GET against
    //      the proxy returns the upstream's body.
    //
    // Both effects must be present — if only one fires, only one
    // assertion passes and the test catches the regression.

    // 1. Spin up a real upstream (Bun.serve on an ephemeral port).
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("hello from upstream", { status: 200 }),
    });
    const upstreamUrl = `http://127.0.0.1:${upstream.port}`;

    try {
      const controller = new AbortController();
      const { stream, output } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      // Wait for startup. We need BOTH the dashboard URL file AND the
      // proxy's log line (the proxy port is dynamic since we pass 0).
      let dashboardUrl: string | null = null;
      const startDeadline = Date.now() + 2_000;
      while (Date.now() < startDeadline) {
        dashboardUrl = await readDaemonUrl({ lichHome: home });
        if (dashboardUrl !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(dashboardUrl).not.toBeNull();

      // Pull the proxy port out of the log line. The log line is
      // emitted by `runDaemon` right after `startProxy` resolves.
      const proxyMatch = output().match(
        /proxy listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );
      expect(proxyMatch).not.toBeNull();
      const proxyPort = Number(proxyMatch?.[1]);
      expect(proxyPort).toBeGreaterThan(0);

      // 2. Write the routing snapshot post-startup. The watcher fires
      // after its 100ms debounce; both pipelines refresh.
      const stackDir = join(home, "stacks", "added-stack");
      mkdirSync(stackDir, { recursive: true });
      writeFileSync(
        join(stackDir, "state.json"),
        JSON.stringify({
          stack_id: "added-stack",
          worktree_name: "added",
          worktree_path: "/tmp/added",
          status: "up",
          started_at: new Date().toISOString(),
          services: [],
          routing: [
            {
              hostname: "api.added",
              upstream_url: upstreamUrl,
              service: "api",
            },
          ],
        }) + "\n",
        "utf8",
      );

      // 3a. Dashboard refresh: poll /api/stacks until the new stack
      // appears with the correct primary_url. The watcher debounce is
      // 100ms; 2s with backoff is plenty even on slow CI.
      let dashboardOk = false;
      const refreshDeadline = Date.now() + 2_000;
      while (Date.now() < refreshDeadline) {
        const r = await fetch(`${dashboardUrl}/api/stacks`);
        const stacks = (await r.json()) as Array<{
          id: string;
          primary_url?: string;
        }>;
        const added = stacks.find((s) => s.id === "added-stack");
        if (added && added.primary_url === upstreamUrl) {
          dashboardOk = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(dashboardOk).toBe(true);

      // 3b. Routing reload: hit the proxy with the friendly Host
      // header. The routing table should now contain `api.added` →
      // upstream, so the request gets forwarded and the upstream's
      // body comes back.
      let proxyOk = false;
      const proxyDeadline = Date.now() + 2_000;
      while (Date.now() < proxyDeadline) {
        try {
          const headers = new Headers();
          headers.set("Host", "api.added.lich.localhost");
          const r = await fetch(`http://127.0.0.1:${proxyPort}/`, {
            headers,
          });
          if (r.status === 200) {
            const body = await r.text();
            if (body === "hello from upstream") {
              proxyOk = true;
              break;
            }
          } else {
            // Drain the body so we don't leak a connection on retry.
            await r.text().catch(() => {});
          }
        } catch {
          // Connection refused / reset — retry inside the deadline.
        }
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(proxyOk).toBe(true);

      controller.abort();
      await daemonPromise;
    } finally {
      upstream.stop(true);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  });

  it("uses the configured proxy port (binds proxy on requested port)", async () => {
    // With an ephemeral port the OS picks a fresh one each test run,
    // so we can verify the proxy binds without colliding with other
    // tests. The proxy's "listening on http://localhost:<port>" log
    // line carries the actual bound port; assert that line shows up.
    const { stream, output } = captureLog();

    const result = await runDaemon({
      lichHome: home,
      proxyPort: 0, // ephemeral — Bun assigns a port
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // The log line names the actual bound port; we can't predict it
    // but we can assert the shape.
    expect(output()).toMatch(/proxy listening on http:\/\/127\.0\.0\.1:\d+/);
    // And the dashboard also bound.
    expect(output()).toMatch(/dashboard listening on http:\/\/127\.0\.0\.1:\d+/);
  });
});

// ---------------------------------------------------------------------------
// 4b. Cleanup on shutdown stops both servers + clears both files
// ---------------------------------------------------------------------------

describe("runDaemon — shutdown teardown", () => {
  it("clears daemon.pid AND daemon.url on clean shutdown", async () => {
    writeFakeStack("teardown-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup — both files should be present.
    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      if (
        existsSync(join(home, "daemon.pid")) &&
        existsSync(join(home, "daemon.url"))
      )
        break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    expect(existsSync(join(home, "daemon.url"))).toBe(true);

    // Shut down. Both files must be gone after the promise resolves
    // (cleanup is awaited inside runDaemon before it returns).
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(existsSync(join(home, "daemon.url"))).toBe(false);
    expect(await readDaemonUrl({ lichHome: home })).toBeNull();
  });

  it("stops the dashboard server on shutdown (URL becomes unreachable)", async () => {
    // Real network IO again: after shutdown, fetching the recorded
    // URL should fail with connection-refused. This is the observable
    // proof that `dashboardServer.stop()` actually tore down the
    // listener — without it, the next test on the same port would
    // either collide or see stale responses.
    writeFakeStack("dashboard-stop-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Grab the URL.
    let url: string | null = null;
    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    // Confirm it's up.
    const beforeRes = await fetch(`${url}/healthz`);
    expect(beforeRes.status).toBe(200);
    // Drain the body so Bun doesn't hold the connection on shutdown.
    await beforeRes.text();

    // Shut down.
    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);

    // Fetch should now fail (connection refused). We don't assert
    // a specific error code — different Node/Bun versions surface
    // this differently — just that fetch rejects.
    let rejected = false;
    try {
      await fetch(`${url}/healthz`);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent abort doesn't double-cleanup
// ---------------------------------------------------------------------------

describe("runDaemon — concurrent abort safety", () => {
  it("survives multiple rapid signal.abort() calls without erroring", async () => {
    writeFakeStack("test-stack-4", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    // Wait for startup.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // Fire the abort signal multiple times in rapid succession. Each
    // `abort()` call dispatches the 'abort' event again on AbortSignal,
    // but our handler is idempotent so this should be safe.
    controller.abort();
    controller.abort();
    controller.abort();

    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("running runDaemon twice sequentially leaves a clean state each time", async () => {
    // First run.
    const c1 = new AbortController();
    const { stream: s1 } = captureLog();
    const d1 = startDaemon({
      signal: c1.signal,
      out: s1,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline1 = Date.now() + 2_000;
    while (Date.now() < deadline1) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    c1.abort();
    const r1 = await d1;
    expect(r1.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    // Second run — must succeed since the first cleared the PID file.
    const c2 = new AbortController();
    const { stream: s2 } = captureLog();
    const d2 = startDaemon({
      signal: c2.signal,
      out: s2,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline2 = Date.now() + 2_000;
    while (Date.now() < deadline2) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
    c2.abort();
    const r2 = await d2;
    expect(r2.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. LICH_HOME plumbing — env restoration on shutdown
// ---------------------------------------------------------------------------

describe("runDaemon — LICH_HOME env handling", () => {
  it("restores process.env.LICH_HOME on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    const sentinel = "/should-be-restored";
    process.env.LICH_HOME = sentinel;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      // Wait for startup — at which point env.LICH_HOME has been
      // mutated to `home`. Verify the mutation happened.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      // Shut down, then verify the env was restored.
      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBe(sentinel);
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });

  it("restores an UNSET LICH_HOME (delete) on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    delete process.env.LICH_HOME;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBeUndefined();
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Stack snapshot reading — robustness
// ---------------------------------------------------------------------------

describe("runDaemon — state directory robustness", () => {
  it("treats unreadable/malformed state.json as not-alive (does not crash)", async () => {
    // Put a malformed JSON file where state.json should be. The
    // daemon's count-alive-stacks should treat it as not alive and
    // proceed to auto-shutdown.
    const stackDir = join(home, "stacks", "broken-stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "state.json"), "{ not valid json", "utf8");

    const { stream } = captureLog();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // Original file should still be there — we didn't touch it.
    expect(
      readFileSync(join(stackDir, "state.json"), "utf8").includes("not valid"),
    ).toBe(true);
  });

  it("handles an empty stacks directory by auto-shutting down", async () => {
    // Pre-create the stacks dir but leave it empty.
    mkdirSync(join(home, "stacks"), { recursive: true });
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
  });

  it("tolerates a missing stacks directory entirely", async () => {
    // home exists; <home>/stacks does NOT. The watcher should create
    // the directory, the auto-shutdown count should return 0, and
    // the daemon should exit cleanly.
    expect(existsSync(join(home, "stacks"))).toBe(false);
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // The watcher's start() creates the stacks dir as a side effect.
    expect(existsSync(join(home, "stacks"))).toBe(true);
  });
});
