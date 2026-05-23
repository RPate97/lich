import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { waitForHttp200, waitForTcpOpen } from "./wait.js";

describe("waitForHttp200", () => {
  it("resolves when the server returns 200", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as any).port;

    await expect(
      waitForHttp200(`http://localhost:${port}`, { timeoutMs: 5000 })
    ).resolves.toBeUndefined();

    server.close();
  });

  it("rejects on timeout", async () => {
    await expect(
      waitForHttp200("http://localhost:1", { timeoutMs: 500 })
    ).rejects.toThrow(/timeout/i);
  });
});

describe("waitForTcpOpen", () => {
  it("resolves when port is listening", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as any).port;

    await expect(
      waitForTcpOpen("localhost", port, { timeoutMs: 5000 })
    ).resolves.toBeUndefined();

    server.close();
  });

  it("rejects on timeout", async () => {
    await expect(
      waitForTcpOpen("localhost", 1, { timeoutMs: 500 })
    ).rejects.toThrow(/timeout/i);
  });
});
