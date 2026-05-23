import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { waitForHttpReady } from "../../../src/ready/http-get.js";

// Track servers per test so afterEach can tear them all down.
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers = [];
});

/**
 * Start an HTTP server bound to a random free port (port 0). Returns the
 * URL once it's listening. The server is tracked for afterEach cleanup.
 */
async function startServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ url: string; port: number; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}/`, port: addr.port, server };
}

/**
 * Pick a free port by binding to 0 on a throwaway server and immediately
 * closing it. The returned port is very likely still free moments later
 * — fine for tests that want a closed port.
 */
async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("waitForHttpReady", () => {
  it("resolves immediately when the server returns 200", async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const start = Date.now();
    await waitForHttpReady({ url, intervalMs: 25 });
    const elapsed = Date.now() - start;

    // Should resolve fast — well within a couple intervals.
    expect(elapsed).toBeLessThan(200);
  });

  it("keeps polling on 5xx and resolves once the server flips to 2xx", async () => {
    let attempts = 0;
    const { url } = await startServer((_req, res) => {
      attempts += 1;
      if (attempts <= 3) {
        res.writeHead(503);
        res.end("not ready");
      } else {
        res.writeHead(200);
        res.end("ready");
      }
    });

    const start = Date.now();
    await waitForHttpReady({ url, intervalMs: 25 });
    const elapsed = Date.now() - start;

    // 3 failed attempts → 3 sleeps of 25ms before the successful 4th.
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(elapsed).toBeLessThan(400);
  });

  it("keeps polling when the port is closed and resolves once a server binds to it", async () => {
    const port = await pickFreePort();
    const url = `http://127.0.0.1:${port}/`;

    // Kick off the wait BEFORE the server exists.
    const waiter = waitForHttpReady({ url, intervalMs: 25 });

    // Bring the server up shortly after — wait must catch it.
    setTimeout(() => {
      const server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      servers.push(server);
      server.listen(port, "127.0.0.1");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    // Must have waited for at least the delay before the server came up.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(400);
  });

  it("rejects with an aborted error when the AbortSignal fires", async () => {
    // Server always returns 503 so we definitely sit in the polling loop.
    const { url } = await startServer((_req, res) => {
      res.writeHead(503);
      res.end("nope");
    });

    const controller = new AbortController();
    const waiter = waitForHttpReady({
      url,
      intervalMs: 25,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 40);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("honors intervalMs — a failing endpoint is polled many times in a short window", async () => {
    let attempts = 0;
    const { url } = await startServer((_req, res) => {
      attempts += 1;
      res.writeHead(503);
      res.end("nope");
    });

    const controller = new AbortController();
    const waiter = waitForHttpReady({
      url,
      intervalMs: 25,
      signal: controller.signal,
    });

    // Let it poll for ~200ms then abort.
    setTimeout(() => controller.abort(), 200);

    await expect(waiter).rejects.toThrow(/abort/i);

    // At intervalMs=25 with a 200ms window we'd expect multiple attempts.
    // Be lenient about exact count (timer jitter on CI) but require at
    // least a few — proves we didn't accidentally sleep for the default
    // 250ms.
    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});
