import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// hoisted mock — same pattern as up-daemon-trigger.test.ts
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
    port: { published_env: PORT }
    ready_when:
      log_match: "READY"
`,
    "utf8",
  );
}

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

describe("runUp wait-for-routing — happy path", () => {
  it("calls POST /api/routing/reload then GET /api/routing and returns fast", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

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
    expect(text()).not.toMatch(/routing.*did not appear/);
    expect(text()).not.toMatch(/older build/);
  });
});

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
    const calls = stub!.getCalls();
    expect(calls.get).toBeGreaterThan(1);
    expect(text()).not.toMatch(/routing.*did not appear/);
  });
});

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

describe("runUp wait-for-routing — timeout", () => {
  it("emits one warning and continues when the expected hostname never appears", async () => {
    writeYamlOneService();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    // shortened timeout so the test runs in ~200ms vs default 5s
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
