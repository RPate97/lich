import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  computeTailOffset,
  type DashboardServer,
  type LogTailLike,
  type TailFactory,
} from "../../../../src/daemon/dashboard/server.js";

/** Observable, deterministic LogTail fake — no real polling. */
class FakeLogTail implements LogTailLike {
  readonly logPath: string;
  readonly startOffset: number;
  started = false;
  stopped = false;
  stopCalls = 0;
  private subscribers: Array<(line: string) => void> = [];

  constructor(logPath: string, startOffset = 0) {
    this.logPath = logPath;
    this.startOffset = startOffset;
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

  emit(line: string): void {
    if (this.stopped) return;
    for (const cb of [...this.subscribers]) cb(line);
  }
}

class FakeTailRegistry {
  readonly tails: FakeLogTail[] = [];
  readonly factory: TailFactory = (opts) => {
    const tail = new FakeLogTail(opts.logPath, opts.startOffset ?? 0);
    this.tails.push(tail);
    return tail;
  };

  byLogPathSuffix(suffix: string): FakeLogTail | undefined {
    return this.tails.find((t) => t.logPath.endsWith(suffix));
  }
}

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

function writeStateJson(
  stackId: string,
  data: Record<string, unknown> | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

function url(path: string): string {
  if (!server) throw new Error("server not started");
  return server.url + path;
}

/**
 * Parse `n` SSE frames from `res.body`. Returns once n frames arrive or stream closes.
 * Each event ends at `\n\n` and contains one `data: <json>` line.
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
    const readPromise = reader.read();
    const remaining = deadline - Date.now();
    const timeoutPromise = new Promise<{ done: true; value?: undefined }>(
      (resolve) => setTimeout(() => resolve({ done: true }), Math.max(0, remaining)),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let split = buf.indexOf("\n\n");
    while (split >= 0) {
      const frame = buf.slice(0, split);
      buf = buf.slice(split + 2);
      const lineMatch = /^data:\s*(.*)$/m.exec(frame);
      if (lineMatch) {
        frames.push(JSON.parse(lineMatch[1]));
      }
      if (frames.length >= n) break;
      split = buf.indexOf("\n\n");
    }
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}

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

async function tick(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 10));
}

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

    await waitFor(() => registry.tails.length === 1);
    const tail = registry.tails[0];
    expect(tail.started).toBe(true);

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

    const fetchPromise = fetch(url("/api/stacks/stack-abc/logs?service=api"));
    await waitFor(() => registry.tails.length === 1);

    expect(registry.tails[0].logPath).toBe(
      join(stateRoot, "stack-abc", "logs", "api.log"),
    );

    const res = await fetchPromise;
    await res.body?.cancel();
  });
});

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

    expect(registry.tails).toHaveLength(1);
    expect(registry.tails[0].logPath.endsWith("/logs/web.log")).toBe(true);

    const res = await fetchPromise;
    await res.body?.cancel();
  });
});

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

    await waitFor(() => registry.tails.length === 2);
    const apiTail = registry.byLogPathSuffix("/logs/api.log");
    const webTail = registry.byLogPathSuffix("/logs/web.log");
    expect(apiTail).toBeDefined();
    expect(webTail).toBeDefined();

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
    await tick();
    expect(registry.tails).toHaveLength(0);
    await res.body?.cancel();
  });
});

describe("SSE log stream — stack not found", () => {
  it("returns 404 when the stack id doesn't exist (filtered)", async () => {
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const res = await fetch(url("/api/stacks/missing/logs?service=api"));
    expect(res.status).toBe(404);
    expect(registry.tails).toHaveLength(0);
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

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url(`/api/stacks/${stackId}/logs?service=api`));
    expect(res.status).toBe(200);

    // real LogTail polls at 100ms — allow up to 1s for pickup
    setTimeout(() => {
      writeFileSync(logPath, "line one\n", { flag: "a" });
    }, 50);

    const frames = await readNFrames(res, 1, { timeoutMs: 2000 });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ service: "api", line: "line one" });
  });
});

describe("computeTailOffset", () => {
  it("returns 0 for a non-existent file", async () => {
    const offset = await computeTailOffset("/tmp/does-not-exist-lich.log", 10);
    expect(offset).toBe(0);
  });

  it("returns 0 for an empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-tail-offset-"));
    try {
      const logPath = join(dir, "empty.log");
      writeFileSync(logPath, "", "utf8");
      const offset = await computeTailOffset(logPath, 10);
      expect(offset).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when the file has fewer lines than tailLines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-tail-offset-"));
    try {
      const logPath = join(dir, "short.log");
      writeFileSync(logPath, "line1\nline2\nline3\n", "utf8");
      const offset = await computeTailOffset(logPath, 10);
      expect(offset).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an offset that skips all but the last tailLines lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-tail-offset-"));
    try {
      const logPath = join(dir, "many.log");
      const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
      writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

      const tailLines = 10;
      const offset = await computeTailOffset(logPath, tailLines);

      // The offset should land us at "line41" (the 41st line, 10 from the end).
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(logPath, "utf8");
      const fromOffset = content.slice(offset);
      const gotLines = fromOffset.split("\n").filter((l) => l.length > 0);
      expect(gotLines).toHaveLength(tailLines);
      expect(gotLines[0]).toBe("line41");
      expect(gotLines[gotLines.length - 1]).toBe("line50");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SSE log stream — per-service tail isolation (merged)", () => {
  it("each service tail receives an independent startOffset from its own log file", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "web", kind: "owned", state: "ready" },
        { name: "tunnel", kind: "owned", state: "ready" },
      ],
    });

    // web log has many lines (chatty); tunnel log has few lines (quiet).
    const webLogsDir = join(stateRoot, "stack-1", "logs");
    mkdirSync(webLogsDir, { recursive: true });
    const webLines = Array.from({ length: 300 }, (_, i) => `web-line-${i + 1}`).join("\n") + "\n";
    const tunnelLines = "tunnel-startup\ntunnel-ready\n";
    writeFileSync(join(webLogsDir, "web.log"), webLines, "utf8");
    writeFileSync(join(webLogsDir, "tunnel.log"), tunnelLines, "utf8");

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const fetchPromise = fetch(url("/api/stacks/stack-1/logs"));
    await waitFor(() => registry.tails.length === 2);

    const webTail = registry.byLogPathSuffix("/logs/web.log");
    const tunnelTail = registry.byLogPathSuffix("/logs/tunnel.log");
    expect(webTail).toBeDefined();
    expect(tunnelTail).toBeDefined();

    // web has 300 lines — offset should be > 0 (skip old lines).
    expect(webTail!.startOffset).toBeGreaterThan(0);
    // tunnel has only 2 lines — offset should be 0 (read all).
    expect(tunnelTail!.startOffset).toBe(0);

    const res = await fetchPromise;
    await res.body?.cancel();
  });

  it("each service tail receives an independent startOffset (single-service)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [{ name: "web", kind: "owned", state: "ready" }],
    });

    const logsDir = join(stateRoot, "stack-1", "logs");
    mkdirSync(logsDir, { recursive: true });
    const webLines = Array.from({ length: 300 }, (_, i) => `web-line-${i + 1}`).join("\n") + "\n";
    writeFileSync(join(logsDir, "web.log"), webLines, "utf8");

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      tailFactory: registry.factory,
    });

    const fetchPromise = fetch(url("/api/stacks/stack-1/logs?service=web"));
    await waitFor(() => registry.tails.length === 1);

    expect(registry.tails[0].startOffset).toBeGreaterThan(0);

    const res = await fetchPromise;
    await res.body?.cancel();
  });
});
