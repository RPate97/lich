import { describe, it, expect, afterEach } from "vitest";
import { startDashboardServer, type DashboardServer } from "../../../src/daemon/dashboard/server.js";

let server: DashboardServer | null = null;

afterEach(async () => {
  if (server) { await server.stop(); server = null; }
});

describe("startDashboardServer hostname option", () => {
  it("defaults to 127.0.0.1 when no hostname passed", async () => {
    server = await startDashboardServer({ port: 0, stateRoot: "/tmp/no-such-dir" });
    expect(server.url).toContain("127.0.0.1");
  });

  it("honors custom hostname (e.g., 0.0.0.0)", async () => {
    server = await startDashboardServer({ port: 0, hostname: "0.0.0.0", stateRoot: "/tmp/no-such-dir" });
    expect(server.url).toContain("0.0.0.0");
  });
});
