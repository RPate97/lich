import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoutingTable } from "../../../../src/daemon/proxy/routing.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-proxy-routing-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function writeStateJson(
  stackId: string,
  data: {
    status?: string;
    routing?: Array<{ hostname: string; upstream_url: string; service?: string }>;
  } | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

describe("RoutingTable.reload — empty / missing stateRoot", () => {
  it("returns empty table for an empty stateRoot", async () => {
    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
    expect(table.get("api.feature-x")).toBeUndefined();
  });

  it("returns empty table when stateRoot does not exist", async () => {
    const missing = join(stateRoot, "does-not-exist");
    const table = new RoutingTable();
    await expect(table.reload(missing)).resolves.toBeUndefined();
    expect(table.size()).toBe(0);
  });
});

describe("RoutingTable.reload — single state.json", () => {
  it("indexes a single routing entry and returns it via get()", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        {
          hostname: "api.feature-x",
          upstream_url: "http://127.0.0.1:9014",
          service: "api",
        },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.size()).toBe(1);
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9014");
  });

  it("returns undefined for a hostname not in the table", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.get("nope.main")).toBeUndefined();
  });
});

describe("RoutingTable.reload — multiple state.json files", () => {
  it("merges routing entries from every stack into one table", async () => {
    writeStateJson("stack-a", {
      status: "up",
      routing: [
        { hostname: "api.main", upstream_url: "http://127.0.0.1:9001" },
        { hostname: "web.main", upstream_url: "http://127.0.0.1:9002" },
      ],
    });
    writeStateJson("stack-b", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9101" },
        { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9102" },
      ],
    });
    writeStateJson("stack-c", {
      status: "up",
      routing: [
        { hostname: "db.feature-y", upstream_url: "http://127.0.0.1:9201" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.size()).toBe(5);
    expect(table.get("api.main")).toBe("http://127.0.0.1:9001");
    expect(table.get("web.main")).toBe("http://127.0.0.1:9002");
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9101");
    expect(table.get("web.feature-x")).toBe("http://127.0.0.1:9102");
    expect(table.get("db.feature-y")).toBe("http://127.0.0.1:9201");
  });
});

describe("RoutingTable.reload — hostname collisions", () => {
  it("uses last-writer-wins semantics on a fresh reload", async () => {
    // readdir order is the tiebreaker; one winner is stable across reloads
    writeStateJson("stack-a", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });
    writeStateJson("stack-b", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9002" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.size()).toBe(1);
    const winner = table.get("api.feature-x");
    expect([
      "http://127.0.0.1:9001",
      "http://127.0.0.1:9002",
    ]).toContain(winner);

    const firstWinner = winner;
    await table.reload(stateRoot);
    expect(table.get("api.feature-x")).toBe(firstWinner);
  });
});

describe("RoutingTable.get — case-insensitive lookup (RFC 9110)", () => {
  it("matches uppercase request against lowercase stored key", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.get("API.FEATURE-X")).toBe("http://127.0.0.1:9014");
    expect(table.get("Api.Feature-X")).toBe("http://127.0.0.1:9014");
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9014");
  });

  it("normalizes mixed-case stored hostnames to lowercase too", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "API.MAIN", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.get("api.main")).toBe("http://127.0.0.1:9001");
    expect(table.get("API.MAIN")).toBe("http://127.0.0.1:9001");
  });
});

describe("RoutingTable.reload — snapshots without `routing`", () => {
  it("ignores a snapshot missing the routing field", async () => {
    writeStateJson("stack-1", { status: "up" });

    const table = new RoutingTable();
    await expect(table.reload(stateRoot)).resolves.toBeUndefined();
    expect(table.size()).toBe(0);
  });

  it("ignores an empty `routing: []` (just-torn-down stack)", async () => {
    writeStateJson("stack-1", { status: "up", routing: [] });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
  });
});

describe("RoutingTable.reload — malformed state.json", () => {
  it("ignores a state.json that is not valid JSON (logs, does not throw)", async () => {
    writeStateJson("broken", "this is not valid json {{{");
    writeStateJson("good", {
      status: "up",
      routing: [
        { hostname: "api.main", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const table = new RoutingTable();
    await expect(table.reload(stateRoot)).resolves.toBeUndefined();

    expect(table.size()).toBe(1);
    expect(table.get("api.main")).toBe("http://127.0.0.1:9001");

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores entries with missing hostname or upstream_url fields", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        // @ts-expect-error — intentional shape violation; reader skips rather than throws
        { upstream_url: "http://127.0.0.1:9001" },
        // @ts-expect-error — same idea, no upstream_url
        { hostname: "api.main" },
        {
          hostname: "web.main",
          upstream_url: "http://127.0.0.1:9002",
        },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.size()).toBe(1);
    expect(table.get("web.main")).toBe("http://127.0.0.1:9002");
  });
});

describe("RoutingTable.reload — observability of file changes", () => {
  it("reflects an updated state.json after a fresh reload", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9001");

    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9999" },
      ],
    });

    await table.reload(stateRoot);
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9999");
  });

  it("clears entries when their owning stack's state.json removes them", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(1);

    writeStateJson("stack-1", { status: "up", routing: [] });
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
    expect(table.get("api.feature-x")).toBeUndefined();
  });
});

describe("RoutingTable.reload — status filter", () => {
  it("excludes routes from a stack with status=stopped", async () => {
    writeStateJson("stack-stopped", {
      status: "stopped",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });
    writeStateJson("stack-live", {
      status: "up",
      routing: [
        { hostname: "web.main", upstream_url: "http://127.0.0.1:9002" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    expect(table.size()).toBe(1);
    expect(table.get("api.feature-x")).toBeUndefined();
    expect(table.get("web.main")).toBe("http://127.0.0.1:9002");
  });

  it("excludes routes from a stack with status=failed", async () => {
    writeStateJson("stack-failed", {
      status: "failed",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
  });
});

describe("RoutingTable.list — diagnostic snapshot", () => {
  it("returns an empty array when the table has no entries", async () => {
    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.list()).toEqual([]);
  });

  it("returns entries sorted by hostname for deterministic output", async () => {
    // write out of alphabetical order to verify sort
    writeStateJson("stack-3", {
      status: "up",
      routing: [
        {
          hostname: "postgres.feature-x",
          upstream_url: "http://127.0.0.1:9003",
        },
      ],
    });
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });
    writeStateJson("stack-2", {
      status: "up",
      routing: [
        { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9002" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);

    const list = table.list();
    expect(list).toEqual([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      { hostname: "postgres.feature-x", upstream_url: "http://127.0.0.1:9003" },
      { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9002" },
    ]);
  });

  it("returns a copy — subsequent reload() does not mutate a previously-returned list", async () => {
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9001" },
      ],
    });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    const snapshot = table.list();
    expect(snapshot).toHaveLength(1);

    writeStateJson("stack-1", { status: "stopped", routing: [] });
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].hostname).toBe("api.feature-x");
  });
});
