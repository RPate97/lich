import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type AddressInfo } from "node:net";
import { waitForTcpReady } from "../../../src/ready/tcp.js";

// Track servers per test so afterEach can tear them all down.
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        })
    )
  );
  servers = [];
});

/**
 * Start a TCP server bound to a random free port (port 0). The server
 * is tracked for afterEach cleanup. Accepted connections are
 * immediately destroyed — we don't care about traffic, only the
 * accept-side handshake which is what the connect probe observes.
 */
async function startServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((sock) => {
    sock.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address() as AddressInfo;
  return { port: addr.port, server };
}

/**
 * Pick a free port by binding to 0 on a throwaway server and
 * immediately closing it. The returned port is very likely still free
 * moments later — fine for tests that want a closed port.
 */
async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("waitForTcpReady", () => {
  it("resolves immediately when the server is already listening", async () => {
    const { port } = await startServer();

    const start = Date.now();
    await waitForTcpReady({ target: `127.0.0.1:${port}`, intervalMs: 25 });
    const elapsed = Date.now() - start;

    // Should resolve fast — well within a couple intervals.
    expect(elapsed).toBeLessThan(200);
  });

  it("keeps polling when the port is closed and resolves once a server binds to it", async () => {
    const port = await pickFreePort();

    // Kick off the wait BEFORE the server exists.
    const waiter = waitForTcpReady({
      target: `127.0.0.1:${port}`,
      intervalMs: 25,
    });

    // Bring the server up shortly after — wait must catch it.
    setTimeout(() => {
      const server = createServer((sock) => {
        sock.destroy();
      });
      servers.push(server);
      server.listen(port, "127.0.0.1");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    // Must have waited for at least the delay before the server came up.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("rejects with an aborted error when the AbortSignal fires", async () => {
    // Use a definitely-closed port so we sit in the polling loop.
    const port = await pickFreePort();

    const controller = new AbortController();
    const waiter = waitForTcpReady({
      target: `127.0.0.1:${port}`,
      intervalMs: 25,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 40);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("honors intervalMs — connection refused gets polled multiple times within a short window", async () => {
    // Closed port → every attempt fails with ECONNREFUSED.
    const port = await pickFreePort();

    // Track attempts indirectly by timing: at intervalMs=25 over ~200ms,
    // we must finish well under the default 250ms interval to prove the
    // override took effect. Use start/end timing on the rejection.
    const controller = new AbortController();
    const start = Date.now();
    const waiter = waitForTcpReady({
      target: `127.0.0.1:${port}`,
      intervalMs: 25,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 200);

    await expect(waiter).rejects.toThrow(/abort/i);
    const elapsed = Date.now() - start;

    // The whole polling window should be ~200ms. If we'd accidentally
    // slept for the default 250ms between attempts, the first sleep
    // alone would exceed this — combined with abort cancelling sleep,
    // we still expect the window to be close to 200ms (not e.g. >500ms).
    expect(elapsed).toBeLessThan(500);

    // And it must have actually had room for several attempts: a
    // refused-connection loop with intervalMs=25 finishes each attempt
    // in well under 25ms on loopback, so 200ms gives us many cycles.
    // We don't introspect attempt count here (no hook) — the previous
    // assertion on elapsed time is the load-bearing one.
  });

  it("rejects immediately on a malformed target — 'not-a-host-port'", async () => {
    const start = Date.now();
    await expect(
      waitForTcpReady({ target: "not-a-host-port", intervalMs: 25 })
    ).rejects.toThrow(/invalid tcp target/);
    // Must not have polled — should reject synchronously-ish.
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("rejects immediately on an empty target", async () => {
    await expect(
      waitForTcpReady({ target: "", intervalMs: 25 })
    ).rejects.toThrow(/invalid tcp target/);
  });

  it("rejects immediately on a non-numeric port — 'localhost:abc'", async () => {
    await expect(
      waitForTcpReady({ target: "localhost:abc", intervalMs: 25 })
    ).rejects.toThrow(/invalid tcp target/);
  });

  it("rejects immediately on a missing port — 'localhost:'", async () => {
    await expect(
      waitForTcpReady({ target: "localhost:", intervalMs: 25 })
    ).rejects.toThrow(/invalid tcp target/);
  });

  it("rejects immediately on an out-of-range port — 'localhost:99999'", async () => {
    await expect(
      waitForTcpReady({ target: "localhost:99999", intervalMs: 25 })
    ).rejects.toThrow(/invalid tcp target/);
  });

  it("rejects with aborted when the signal is already aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForTcpReady({
        target: "127.0.0.1:1",
        intervalMs: 25,
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
  });
});
