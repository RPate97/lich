/**
 * Unit tests for the dashboard SSE log-tail endpoints (LEV-409, Plan 5 Task 7).
 *
 * Two routes under test, both extensions of the dashboard HTTP server:
 *
 *   GET /api/stacks/:id/logs?service=<name>  — stream one service's log file
 *   GET /api/stacks/:id/logs                 — merged stream across services
 *
 * Each event is a single SSE frame:
 *   data: {"service":"<name>","line":"<line>"}\n\n
 *
 * The handler opens one {@link LogTail} per service per open connection,
 * subscribes to `onLine`, and tears each tail down on client disconnect.
 * Tests inject a fake LogTail factory so we can:
 *   - emit lines on demand (no real file polling races)
 *   - observe `stop()` calls (verifying the disconnect cleanup path)
 *   - run quickly without 100ms poll intervals from the real tail
 *
 * Coverage (per task spec):
 *   1. ?service= stream emits one SSE frame per LogTail line
 *   2. ?service= filter scopes events to that one service
 *   3. Merged stream (no ?service) covers all services in the stack
 *   4. Stack 404 (unknown stack id)
 *   5. Service 404 (stack exists, service doesn't)
 *   6. Client disconnect stops every LogTail attached to the stream
 *   7. Response headers include `content-type: text/event-stream`
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  type DashboardServer,
  type LogTailLike,
  type TailFactory,
} from "../../../../src/daemon/dashboard/server.js";

// ---------------------------------------------------------------------------
// Fake LogTail — observable, deterministic, no real filesystem polling.
// ---------------------------------------------------------------------------

/**
 * Minimal fake that satisfies {@link LogTailLike}. Tests drive line
 * emission via `emit(line)` and observe lifecycle via `started`,
 * `stopped`, and `stopCalls`. We deliberately don't inherit from the
 * real LogTail — the seam exists exactly so a few-line test fake can
 * substitute for the real poll-loop machinery.
 */
class FakeLogTail implements LogTailLike {
  readonly logPath: string;
  started = false;
  stopped = false;
  stopCalls = 0;
  private subscribers: Array<(line: string) => void> = [];

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.started = true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    this.stopCalls++;
    this.stopped = true;
  }

  onLine(cb: (line: string) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * Synchronously deliver `line` to every subscriber. Tests use this to
   * step the stream forward without waiting on a real poll tick.
   */
  emit(line: string): void {
    if (this.stopped) return;
    for (const cb of [...this.subscribers]) cb(line);
  }
}

/**
 * Registry of fakes per test so assertions can reach the tail instance
 * for `logPath` and `stopCalls` checks. The factory below records every
 * tail it constructs into the registry keyed by logPath.
 */
class FakeTailRegistry {
  readonly tails: FakeLogTail[] = [];
  readonly factory: TailFactory = (opts) => {
    const tail = new FakeLogTail(opts.logPath);
    this.tails.push(tail);
    return tail;
  };

  byLogPathSuffix(suffix: string): FakeLogTail | undefined {
    return this.tails.find((t) => t.logPath.endsWith(suffix));
  }
}

// ---------------------------------------------------------------------------
// Fixture harness — tmpdir state root + server torn down per test.
// ---------------------------------------------------------------------------

let stateRoot: string;
let server: DashboardServer | null = null;
let registry: FakeTailRegistry;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-log-stream-"));
  registry = new FakeTailRegistry();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

/** Same synthetic state.json writer used in server.test.ts. */
function writeStateJson(
  stackId: string,
  data: Record<string, unknown> | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

/** Compose a URL against the running server. */
function url(path: string): string {
  if (!server) throw new Error("server not started");
  return server.url + path;
}

/**
 * Parse `n` SSE frames from `res.body`. Each frame is one parsed JSON
 * object from the `data:` line. Resolves once `n` frames have arrived
 * OR the stream closes (in which case fewer frames may be returned —
 * the caller asserts on length).
 *
 * SSE framing per the spec: events end with `\n\n`. Each event has one
 * or more `data: <payload>` lines. We only emit `data:` lines so the
 * payload is one line per event — we read until we see two consecutive
 * newlines, then JSON.parse the part after `data: `.
 */
async function readNFrames(
  res: Response,
  n: number,
  opts: { timeoutMs?: number } = {},
): Promise<Array<{ service: string; line: string }>> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ service: string; line: string }> = [];
  let buf = "";
  const timeoutMs = opts.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (frames.length < n && Date.now() < deadline) {
    // Race the read against a short timeout so a slow stream doesn't
    // hang the test indefinitely. The outer `while` covers the case
    // where data arrives in smaller chunks than expected.
    const readPromise = reader.read();
    const remaining = deadline - Date.now();
    const timeoutPromise = new Promise<{ done: true; value?: undefined }>(
      (resolve) => setTimeout(() => resolve({ done: true }), Math.max(0, remaining)),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Drain complete frames from the buffer. Each terminates at `\n\n`.
    let split = buf.indexOf("\n\n");
    while (split >= 0) {
      const frame = buf.slice(0, split);
      buf = buf.slice(split + 2);
      // Extract the data: line. Per spec we only emit one per frame.
      const lineMatch = /^data:\s*(.*)$/m.exec(frame);
      if (lineMatch) {
        frames.push(JSON.parse(lineMatch[1]));
      }
      if (frames.length >= n) break;
      split = buf.indexOf("\n\n");
    }
  }
  // Best-effort cancel so we don't leak the underlying socket.
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}

/**
 * Poll a predicate until true or deadline elapses. Mirrors `waitFor` in
 * server.test.ts and watcher.test.ts.
 */
async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

/** Tiny await tick — gives `start()` time to run + tail to be registered. */
async function tick(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// 1. ?service= stream emits one SSE frame per LogTail line
// ---------------------------------------------------------------------------

describe("SSE log stream — single-service endpoint", () => {
  it("streams lines from the LogTail as SSE frames", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "api", kind: "owned", state: "ready" },
      ],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/stack-1/logs?service=api"));
    expect(res.status).toBe(200);

    // Wait for the factory to have constructed and started the tail.
    await waitFor(() => registry.tails.length === 1);
    const tail = registry.tails[0];
    expect(tail.started).toBe(true);

    // Read 3 frames AFTER emitting 3 lines. We emit in the background
    // so the consumer side has time to install the reader.
    setTimeout(() => {
      tail.emit("hello");
      tail.emit("world");
      tail.emit("third");
    }, 10);

    const frames = await readNFrames(res, 3, { timeoutMs: 1000 });
    expect(frames).toEqual([
      { service: "api", line: "hello" },
      { service: "api", line: "world" },
      { service: "api", line: "third" },
    ]);
  });

  it("uses the correct log file path for the service", async () => {
    writeStateJson("stack-abc", {
      stack_id: "stack-abc",
      worktree_name: "feature-y",
      worktree_path: "/tmp/feature-y",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    // Kick the request off in the background so the factory runs.
    const fetchPromise = fetch(url("/api/stacks/stack-abc/logs?service=api"));
    await waitFor(() => registry.tails.length === 1);

    // The log path must follow <stateRoot>/<stackId>/logs/<service>.log.
    expect(registry.tails[0].logPath).toBe(
      join(stateRoot, "stack-abc", "logs", "api.log"),
    );

    const res = await fetchPromise;
    // Drain and cancel so afterEach doesn't see a leaked reader.
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// 2. ?service= filter scopes events to that one service
// ---------------------------------------------------------------------------

describe("SSE log stream — single-service filter", () => {
  it("constructs only one LogTail (for the requested service)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "api", kind: "owned", state: "ready" },
        { name: "web", kind: "compose", state: "healthy" },
        { name: "worker", kind: "owned", state: "ready" },
      ],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const fetchPromise = fetch(url("/api/stacks/stack-1/logs?service=web"));
    await waitFor(() => registry.tails.length === 1);

    // Only one tail (for `web`); the other two services are NOT tailed
    // on a filtered stream.
    expect(registry.tails).toHaveLength(1);
    expect(registry.tails[0].logPath.endsWith("/logs/web.log")).toBe(true);

    const res = await fetchPromise;
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// 3. Merged stream — no ?service param — covers every service
// ---------------------------------------------------------------------------

describe("SSE log stream — merged endpoint", () => {
  it("streams interleaved lines from every service in the stack", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "api", kind: "owned", state: "ready" },
        { name: "web", kind: "compose", state: "healthy" },
      ],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/stack-1/logs"));
    expect(res.status).toBe(200);

    // Two tails: one per service.
    await waitFor(() => registry.tails.length === 2);
    const apiTail = registry.byLogPathSuffix("/logs/api.log");
    const webTail = registry.byLogPathSuffix("/logs/web.log");
    expect(apiTail).toBeDefined();
    expect(webTail).toBeDefined();

    // Interleave emissions from both. The merged stream labels each
    // event with the source service so the client can distinguish.
    setTimeout(() => {
      apiTail!.emit("api: hello");
      webTail!.emit("web: hello");
      apiTail!.emit("api: goodbye");
    }, 10);

    const frames = await readNFrames(res, 3, { timeoutMs: 1000 });
    expect(frames).toEqual([
      { service: "api", line: "api: hello" },
      { service: "web", line: "web: hello" },
      { service: "api", line: "api: goodbye" },
    ]);
  });

  it("constructs zero tails when the stack has no services", async () => {
    writeStateJson("empty-stack", {
      stack_id: "empty-stack",
      worktree_name: "empty",
      worktree_path: "/tmp/empty",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/empty-stack/logs"));
    expect(res.status).toBe(200);
    // Allow a tick for any tails to have been constructed (there
    // should be none).
    await tick();
    expect(registry.tails).toHaveLength(0);
    // Cancel the body so the server doesn't hold the stream open.
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// 4. Stack 404
// ---------------------------------------------------------------------------

describe("SSE log stream — stack not found", () => {
  it("returns 404 when the stack id doesn't exist (filtered)", async () => {
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/missing/logs?service=api"));
    expect(res.status).toBe(404);
    // 404 must NOT construct a tail.
    expect(registry.tails).toHaveLength(0);
    // 404 body should be JSON-shaped (matches the rest of the API).
    const body = await res.json();
    expect(body).toMatchObject({ error: "not_found" });
  });

  it("returns 404 when the stack id doesn't exist (merged)", async () => {
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/missing/logs"));
    expect(res.status).toBe(404);
    expect(registry.tails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Service 404 (stack exists, service doesn't)
// ---------------------------------------------------------------------------

describe("SSE log stream — service not found", () => {
  it("returns 404 when the stack exists but the service isn't in it", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/stack-1/logs?service=ghost"));
    expect(res.status).toBe(404);
    expect(registry.tails).toHaveLength(0);
    const body = await res.json();
    expect(body).toMatchObject({ error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// 6. Client disconnect closes the LogTail
// ---------------------------------------------------------------------------

describe("SSE log stream — cleanup on disconnect", () => {
  it("stops the LogTail when the client disconnects (single-service)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const controller = new AbortController();
    const res = await fetch(url("/api/stacks/stack-1/logs?service=api"), {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    await waitFor(() => registry.tails.length === 1);
    const tail = registry.tails[0];
    expect(tail.stopped).toBe(false);

    // Simulate the client dropping. Cancel the response body — this
    // calls ReadableStream.cancel on the server side, which is the
    // path the production code uses to release tails for closed
    // browser tabs.
    try {
      controller.abort();
    } catch {
      // ignore — also drain the body just in case
    }
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }

    // stop() runs from either the cancel() or the abort handler.
    // Wait for whichever happens.
    await waitFor(() => tail.stopped, { timeoutMs: 1000 });
    expect(tail.stopped).toBe(true);
    expect(tail.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops every LogTail when the client disconnects (merged)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "api", kind: "owned", state: "ready" },
        { name: "web", kind: "compose", state: "healthy" },
      ],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const controller = new AbortController();
    const res = await fetch(url("/api/stacks/stack-1/logs"), {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    await waitFor(() => registry.tails.length === 2);

    try {
      controller.abort();
    } catch {
      // ignore
    }
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }

    await waitFor(
      () => registry.tails.every((t) => t.stopped),
      { timeoutMs: 1000 },
    );
    for (const tail of registry.tails) {
      expect(tail.stopped).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Headers: content-type is text/event-stream
// ---------------------------------------------------------------------------

describe("SSE log stream — response headers", () => {
  it("returns content-type: text/event-stream on the filtered stream", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/stack-1/logs?service=api"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("returns content-type: text/event-stream on the merged stream", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/stack-1/logs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// Additional safety: real LogTail integration smoke (no factory injected)
// ---------------------------------------------------------------------------
//
// Catches any wiring regression between the real LogTail (logs/tail.ts)
// and the SSE handler — e.g. an API rename on LogTail that breaks the
// LogTailLike shape would not be caught by the fake-only tests above.
// We use a real log file and append a line; the SSE handler must
// forward it through to the EventSource.

describe("SSE log stream — real LogTail smoke test", () => {
  it("forwards lines from a real log file to the SSE stream", async () => {
    const stackId = "real-stack";
    const logsDir = join(stateRoot, stackId, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, "api.log");
    writeFileSync(logPath, "", "utf8");

    writeStateJson(stackId, {
      stack_id: stackId,
      worktree_name: "real",
      worktree_path: "/tmp/real",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    });

    // No tailFactory override — uses the real LogTail from logs/tail.ts.
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url(`/api/stacks/${stackId}/logs?service=api`));
    expect(res.status).toBe(200);

    // Append after the tail is set up. The real LogTail polls at 100ms
    // by default, so we allow up to 1s for it to pick up the write.
    setTimeout(() => {
      writeFileSync(logPath, "line one\n", { flag: "a" });
    }, 50);

    const frames = await readNFrames(res, 1, { timeoutMs: 2000 });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ service: "api", line: "line one" });
  });
});
