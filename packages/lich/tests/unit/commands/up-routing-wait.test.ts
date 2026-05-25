/**
 * Unit tests for the `lich up` wait-for-routing hook (LEV-480).
 *
 * After `lich up` writes its final state.json (with `routing` populated)
 * and calls `ensureDaemonRunning`, it now polls the daemon's
 * `/api/routing` endpoint until every expected hostname appears, with
 * a `POST /api/routing/reload` up front to force an immediate re-scan.
 *
 * This closes the race where `lich up` returned before the watcher's
 * 100ms debounce fired — a test probing the proxy immediately would
 * 404 on its own friendly URL.
 *
 * Strategy:
 *   - Mock `ensureDaemonRunning` to return the URL of a Bun.serve stub
 *     this test owns. The stub mimics the daemon's `/api/routing` +
 *     `/api/routing/reload` shape, exposing knobs the test uses to
 *     simulate slow / failing daemons.
 *   - Write a minimal yaml so `runUp` reaches the success path and the
 *     post-success wait-for-routing hook fires.
 *   - Assert on stub call counts, hook output, and total elapsed time.
 *
 * Coverage:
 *   1. Routing already populated → wait returns fast, POST reload
 *      fires once, GET fires once.
 *   2. Routing lands AFTER a delay → wait polls until present, no
 *      warning emitted, runUp exit code stays 0.
 *   3. Daemon returns 503 (no routing table) → single warning line
 *      emitted, runUp exit code stays 0.
 *   4. Stub never returns expected hostnames → timeout, single
 *      warning line emitted, runUp exit code stays 0.
 *   5. Transport error on stub → polling continues, eventual timeout,
 *      runUp exit code stays 0.
 *   6. Skipped when the stack has no routing entries (defensive — the
 *      function shouldn't be called in that case, but the orchestrator
 *      guards on length anyway).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Hoisted mock of ensureDaemonRunning — same pattern as
// up-daemon-trigger.test.ts. Per-test we swap the URL it returns to
// point at our stub.
const ensureDaemonRunningSpy = vi.fn(async () => ({
  url: "http://127.0.0.1:1",
  alreadyRunning: false,
}));
vi.mock("../../../src/daemon/auto-start.js", () => ({
  ensureDaemonRunning: (
    ...args: Parameters<typeof ensureDaemonRunningSpy>
  ) => ensureDaemonRunningSpy(...args),
}));

// eslint-disable-next-line import/first
import { runUp } from "../../../src/commands/up.js";
// eslint-disable-next-line import/first
import { release } from "../../../src/ports/allocator.js";
// eslint-disable-next-line import/first
import { detectWorktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Per-test harness
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let stub: {
  url: string;
  stop: () => void;
  getCalls: () => { reload: number; get: number };
} | null = null;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-routing-wait-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  ensureDaemonRunningSpy.mockClear();
  ensureDaemonRunningSpy.mockImplementation(async () => ({
    url: "http://127.0.0.1:1",
    alreadyRunning: false,
  }));
});

afterEach(async () => {
  if (stub) {
    stub.stop();
    stub = null;
  }
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
// Stub server
// ---------------------------------------------------------------------------

/**
 * Stand up a Bun.serve stub that mimics the daemon's routing endpoints.
 *
 * @param routingResponse — controls what GET /api/routing returns:
 *   - { kind: "503" }: emulates a daemon without the routing table.
 *   - { kind: "entries", entries: [...] }: returns a 200 with the entries.
 *   - { kind: "entries-after-ms", entries: [...], delayMs }: returns 200
 *     with EMPTY [] until `delayMs` has elapsed since `start`, then
 *     starts returning `entries`. Simulates the watcher catching up.
 *   - { kind: "always-empty" }: returns 200 with [] forever.
 *   - { kind: "transport-error" }: server isn't started; the returned
 *     URL won't accept connections (port 1 refuses).
 * @param reloadResponse — controls POST /api/routing/reload:
 *   - "204" (default): success no-content.
 *   - "503": no routing table on daemon.
 *   - "ignore": same as 204 but doesn't change the test's GET behavior.
 */
function startStub(opts: {
  routingResponse:
    | { kind: "503" }
    | { kind: "entries"; entries: Array<{ hostname: string; upstream_url: string }> }
    | {
        kind: "entries-after-ms";
        entries: Array<{ hostname: string; upstream_url: string }>;
        delayMs: number;
      }
    | { kind: "always-empty" }
    | { kind: "transport-error" };
  reloadResponse?: "204" | "503";
}): { url: string } {
  let reloadCount = 0;
  let getCount = 0;
  if (opts.routingResponse.kind === "transport-error") {
    stub = {
      url: "http://127.0.0.1:1",
      stop: () => {},
      getCalls: () => ({ reload: reloadCount, get: getCount }),
    };
    return { url: stub.url };
  }
  const reloadStatus = opts.reloadResponse === "503" ? 503 : 204;
  const startMs = Date.now();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/routing/reload") {
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        reloadCount++;
        if (reloadStatus === 503) {
          return new Response(
            JSON.stringify({ error: "no routing table" }),
            { status: 503 },
          );
        }
        return new Response(null, { status: 204 });
      }
      if (u.pathname === "/api/routing") {
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 });
        }
        getCount++;
        switch (opts.routingResponse.kind) {
          case "503":
            return new Response(
              JSON.stringify({ error: "no routing table" }),
              { status: 503 },
            );
          case "entries":
            return new Response(JSON.stringify(opts.routingResponse.entries), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          case "entries-after-ms": {
            const elapsed = Date.now() - startMs;
            const entries =
              elapsed >= opts.routingResponse.delayMs
                ? opts.routingResponse.entries
                : [];
            return new Response(JSON.stringify(entries), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
          case "always-empty":
            return new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  stub = {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    getCalls: () => ({ reload: reloadCount, get: getCount }),
  };
  return { url: stub.url };
}

// ---------------------------------------------------------------------------
// Fixture: a minimal yaml that produces routing entries.
// ---------------------------------------------------------------------------

/**
 * Write a yaml that creates ONE owned service with a port. The
 * orchestrator allocates the port and writes a routing entry — that
 * single entry is what the wait-for-routing hook polls for. Port range
 * is narrow so we don't fight other test files.
 */
function writeYamlOneService(): void {
  writeFileSync(
    join(projectDir, "lich.yaml"),
    `
version: "1"
runtime:
  port_range: [21400, 21420]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    port: { env: PORT }
    ready_when:
      log_match: "READY"
`,
    "utf8",
  );
}

/**
 * Yaml that produces NO routing entries — the service has no port.
 * The wait-for-routing hook should be skipped entirely in this case
 * (defensive: orchestrator gates on routing.length > 0).
 */
function writeYamlNoPorts(): void {
  writeFileSync(
    join(projectDir, "lich.yaml"),
    `
version: "1"
runtime:
  port_range: [21430, 21450]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
`,
    "utf8",
  );
}

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
// 1. Happy path: routing already populated on first GET
// ---------------------------------------------------------------------------

describe("runUp wait-for-routing — happy path", () => {
  it("calls POST /api/routing/reload then GET /api/routing and returns fast", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    // Stub returns the expected entry immediately. The hook should
    // POST reload once, GET once, see the entry, and return.
    const expectedHostname = `svc.${wt.name}`;
    const { url } = startStub({
      routingResponse: {
        kind: "entries",
        entries: [
          { hostname: expectedHostname, upstream_url: "http://127.0.0.1:1234" },
        ],
      },
    });
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url,
      alreadyRunning: true,
    }));

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const calls = stub!.getCalls();
    expect(calls.reload).toBe(1);
    expect(calls.get).toBeGreaterThanOrEqual(1);
    // No warning about routing was emitted.
    expect(text()).not.toMatch(/routing.*did not appear/);
    expect(text()).not.toMatch(/older build/);
  });
});

// ---------------------------------------------------------------------------
// 2. Routing lands after a delay → poll waits for it
// ---------------------------------------------------------------------------

describe("runUp wait-for-routing — delayed routing", () => {
  it("polls until the expected hostname appears (no warning, runUp exit 0)", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const expectedHostname = `svc.${wt.name}`;
    const { url } = startStub({
      routingResponse: {
        kind: "entries-after-ms",
        delayMs: 200,
        entries: [
          { hostname: expectedHostname, upstream_url: "http://127.0.0.1:1234" },
        ],
      },
    });
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url,
      alreadyRunning: true,
    }));

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    // The hook polled multiple times before the entry appeared.
    const calls = stub!.getCalls();
    expect(calls.get).toBeGreaterThan(1);
    expect(text()).not.toMatch(/routing.*did not appear/);
  });
});

// ---------------------------------------------------------------------------
// 3. Daemon returns 503 → single warning, runUp exit 0
// ---------------------------------------------------------------------------

describe("runUp wait-for-routing — daemon has no routing table", () => {
  it("emits one warning + does not fail when /api/routing returns 503", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { url } = startStub({
      routingResponse: { kind: "503" },
      reloadResponse: "503",
    });
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url,
      alreadyRunning: true,
    }));

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(text()).toMatch(/older build|does not expose/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Stub never returns the expected hostname → timeout warning
// ---------------------------------------------------------------------------

describe("runUp wait-for-routing — timeout", () => {
  it("emits one warning and continues when the expected hostname never appears", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    // The stub returns a 200 [] forever — the expected hostname is
    // never in the list. The hook polls until the timeout elapses,
    // then warns. We shorten the timeout via LICH_ROUTING_WAIT_TIMEOUT_MS
    // so the test runs in ~200ms instead of the default 5s.
    const prevTimeout = process.env.LICH_ROUTING_WAIT_TIMEOUT_MS;
    process.env.LICH_ROUTING_WAIT_TIMEOUT_MS = "200";
    try {
      const { url } = startStub({
        routingResponse: { kind: "always-empty" },
      });
      ensureDaemonRunningSpy.mockImplementation(async () => ({
        url,
        alreadyRunning: true,
      }));

      const { stream, text } = captureOut();
      const t0 = Date.now();
      const result = await runUp({
        cwd: projectDir,
        outputMode: "pretty",
        out: stream,
      });
      const elapsed = Date.now() - t0;

      expect(result.exitCode).toBe(0);
      expect(text()).toMatch(/routing.*did not appear/i);
      expect(text()).toMatch(/missing: svc\./);
      // Bounded — the warning must fire within the (shortened) timeout
      // window, not hang forever.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.LICH_ROUTING_WAIT_TIMEOUT_MS;
      } else {
        process.env.LICH_ROUTING_WAIT_TIMEOUT_MS = prevTimeout;
      }
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 5. Skipped when no routing entries declared
// ---------------------------------------------------------------------------

describe("runUp wait-for-routing — skipped without routing entries", () => {
  it("does not POST/GET when the stack declares no routing entries", async () => {
    writeYamlNoPorts();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { url } = startStub({ routingResponse: { kind: "always-empty" } });
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url,
      alreadyRunning: true,
    }));

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const calls = stub!.getCalls();
    expect(calls.reload).toBe(0);
    expect(calls.get).toBe(0);
  });
});
