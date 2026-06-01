import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpStackDataProvider } from "../../../../src/stack/providers/http.js";

let serverUrl: string;
let server: { stop: () => void };

beforeEach(async () => {
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/api/stacks") {
      return new Response(JSON.stringify([{ id: "remote-1", worktree_name: "x", status: "up", services: [] }]), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/stacks/remote-1") {
      return new Response(JSON.stringify({ id: "remote-1", worktree_name: "x", status: "up", services: [{ name: "web", kind: "owned", state: "ready" }] }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/stacks/remote-1/metrics") {
      return new Response(JSON.stringify({ stack_id: "remote-1", sampled_at: "2026-05-31T00:00:00Z", total: { cpu_pct: 7, mem_bytes: 2048 }, services: [] }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/stacks/remote-1/services/web/proc-tree") {
      return new Response(JSON.stringify({ count: 1, cpu_pct: 5, mem_bytes: 1024, root: { pid: 100, ppid: 1, cpu_pct: 5, mem_bytes: 1024, command: "node", children: [] } }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/stacks/remote-1/logs") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: line-1\n\n"));
          controller.enqueue(new TextEncoder().encode("data: line-2\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/stacks/remote-open/logs") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: line-1\n\n"));
          // stream intentionally left open — simulates a live SSE feed
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/stacks/remote-1/metrics/stream") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"cpu\":1}\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  serverUrl = `http://127.0.0.1:${s.port}`;
  server = { stop: () => s.stop(true) };
});

afterEach(() => {
  server.stop();
});

describe("HttpStackDataProvider", () => {
  it("listStacks fetches /api/stacks", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const stacks = await provider.listStacks();
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.id).toBe("remote-1");
  });

  it("loadStack fetches /api/stacks/<remote-stack-id> (ignores local id arg)", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const stack = await provider.loadStack("local-name-that-doesnt-matter");
    expect(stack?.id).toBe("remote-1");
    expect(stack?.services[0]!.name).toBe("web");
  });

  it("loadStack returns null on non-200", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "does-not-exist");
    expect(await provider.loadStack("x")).toBeNull();
  });

  it("metricsLatest fetches /metrics, returns parsed snapshot", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const m = await provider.metricsLatest("x");
    expect(m?.total.cpu_pct).toBe(7);
  });

  it("procTree fetches /services/:svc/proc-tree", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const tree = await provider.procTree("x", "web");
    expect((tree as any)?.root.pid).toBe(100);
  });

  it("tailLogs passes through SSE bytes", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const stream = provider.tailLogs("x", "web", new AbortController().signal);
    const reader = stream.getReader();
    let bytes = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += new TextDecoder().decode(value);
    }
    expect(bytes).toContain("line-1");
    expect(bytes).toContain("line-2");
  });

  it("metricsStream passes through SSE bytes", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const stream = provider.metricsStream("x", new AbortController().signal);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("cpu");
  });

  it("tailLogs closes the passthrough when signal aborts", async () => {
    const controller = new AbortController();
    const provider = new HttpStackDataProvider(serverUrl, "remote-1");
    const stream = provider.tailLogs("x", "web", controller.signal);
    controller.abort();
    const reader = stream.getReader();
    let safeClose = true;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      safeClose = false;
    }
    expect(safeClose).toBe(true);
  });

  it("tailLogs abort fired AFTER stream starts reading still closes cleanly", async () => {
    const provider = new HttpStackDataProvider(serverUrl, "remote-open");
    const controller = new AbortController();
    const stream = provider.tailLogs("x", "web", controller.signal);
    const reader = stream.getReader();

    // Wait for first byte so the writer is definitely acquired.
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Abort mid-stream and verify the readable terminates within 3 seconds.
    controller.abort();
    let closed = false;
    const deadline = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("stream did not close after abort")), 3000),
    );
    await Promise.race([
      (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) { closed = true; return; }
        }
      })(),
      deadline,
    ]);
    expect(closed).toBe(true);
  });
});
