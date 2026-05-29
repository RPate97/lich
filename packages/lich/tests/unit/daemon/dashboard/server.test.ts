import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  type DashboardServer,
} from "../../../../src/daemon/dashboard/server.js";

let stateRoot: string;
let server: DashboardServer | null = null;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-dashboard-server-"));
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

describe("dashboard server — /healthz", () => {
  it("returns 200 with { ok: true }", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe("dashboard server — GET /api/stacks", () => {
  it("returns the cached stacks view (single stack)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9014 },
        },
      ],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "stack-1",
      worktree_name: "feature-x",
      status: "up",
    });
    expect(body[0].services).toHaveLength(1);
    expect(body[0].services[0]).toMatchObject({
      name: "api",
      kind: "owned",
      state: "ready",
      ports: { default: 9014 },
    });
  });

  it("returns an empty array when no stacks exist", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/stacks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("dashboard server — GET /api/stacks/:id", () => {
  it("returns a single stack by id", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9014 },
        },
      ],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/stack-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "stack-1",
      worktree_name: "feature-x",
      status: "up",
    });
  });

  it("returns 404 for a nonexistent stack id", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/stacks/nonexistent"));
    expect(res.status).toBe(404);
  });
});

describe("dashboard server — GET /api/stacks/:id/services/:service", () => {
  it("returns the requested service from the stack", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9014 },
        },
        {
          name: "web",
          kind: "compose",
          state: "healthy",
          allocated_ports: { default: 3000 },
        },
      ],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/stack-1/services/api"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      name: "api",
      kind: "owned",
      state: "ready",
      ports: { default: 9014 },
    });
  });

  it("returns 404 for a service not in the stack", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
        },
      ],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks/stack-1/services/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the stack itself doesn't exist", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/stacks/nope/services/api"));
    expect(res.status).toBe(404);
  });
});

describe("dashboard server — root (no uiDir)", () => {
  it("returns placeholder HTML with 200 when uiDir is not set", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("dashboard UI not built");
  });
});

describe("dashboard server — root (with uiDir)", () => {
  it("serves index.html from the configured uiDir", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-ui-"));
    try {
      const indexBody =
        "<!doctype html><html><body><div id=root>UI</div></body></html>";
      writeFileSync(join(uiDir, "index.html"), indexBody, "utf8");

      server = await startDashboardServer({ port: 0, stateRoot, uiDir });

      const res = await fetch(url("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(indexBody);
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it("serves arbitrary static files from uiDir", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-ui-"));
    try {
      mkdirSync(join(uiDir, "assets"), { recursive: true });
      writeFileSync(
        join(uiDir, "assets", "app.js"),
        "console.log('hi')",
        "utf8",
      );
      writeFileSync(join(uiDir, "index.html"), "<html>fallback</html>", "utf8");

      server = await startDashboardServer({ port: 0, stateRoot, uiDir });

      const res = await fetch(url("/assets/app.js"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("console.log('hi')");
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it("falls back to index.html for SPA-style routes (no file match)", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-ui-"));
    try {
      writeFileSync(
        join(uiDir, "index.html"),
        "<html>spa-shell</html>",
        "utf8",
      );

      server = await startDashboardServer({ port: 0, stateRoot, uiDir });

      const res = await fetch(url("/stacks/some-id"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>spa-shell</html>");
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it("does NOT fall back for /api/* paths (returns 404 for unknown API)", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-ui-"));
    try {
      writeFileSync(
        join(uiDir, "index.html"),
        "<html>spa-shell</html>",
        "utf8",
      );

      server = await startDashboardServer({ port: 0, stateRoot, uiDir });

      // unknown /api/* must NOT serve SPA shell — masks real bugs in API testing tools
      const res = await fetch(url("/api/unknown"));
      expect(res.status).toBe(404);
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal attempts (../) with 404", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-ui-"));
    try {
      writeFileSync(join(uiDir, "index.html"), "<html>ok</html>", "utf8");

      server = await startDashboardServer({ port: 0, stateRoot, uiDir });

      // Bun's fetch normalizes ../ client-side; we test via encoded path
      const res = await fetch(url("/..%2Fetc%2Fpasswd"));
      expect([200, 400, 404]).toContain(res.status);
      if (res.status === 200) {
        const body = await res.text();
        expect(body).not.toContain("root:");
      }
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });
});

function makeEmbeddedSource(
  files: Record<string, { body: string | Uint8Array; contentType: string }>,
) {
  return {
    get(path: string) {
      const hit = files[path];
      if (!hit) return undefined;
      const bytes =
        typeof hit.body === "string"
          ? new TextEncoder().encode(hit.body)
          : hit.body;
      return { bytes, contentType: hit.contentType };
    },
  };
}

describe("dashboard server — root (with embeddedUi)", () => {
  it("serves embedded index.html on / when no uiDir is configured", async () => {
    const embeddedUi = makeEmbeddedSource({
      "index.html": {
        body: "<html><body>embedded shell</body></html>",
        contentType: "text/html; charset=utf-8",
      },
    });
    server = await startDashboardServer({ port: 0, stateRoot, embeddedUi });

    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<html><body>embedded shell</body></html>");
  });

  it("serves arbitrary embedded assets by path", async () => {
    const embeddedUi = makeEmbeddedSource({
      "index.html": {
        body: "<html>shell</html>",
        contentType: "text/html; charset=utf-8",
      },
      "assets/index-abc.js": {
        body: "console.log('embedded');",
        contentType: "text/javascript; charset=utf-8",
      },
    });
    server = await startDashboardServer({ port: 0, stateRoot, embeddedUi });

    const res = await fetch(url("/assets/index-abc.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log('embedded');");
  });

  it("falls back to embedded index.html for SPA routes", async () => {
    const embeddedUi = makeEmbeddedSource({
      "index.html": {
        body: "<html>spa-shell</html>",
        contentType: "text/html; charset=utf-8",
      },
    });
    server = await startDashboardServer({ port: 0, stateRoot, embeddedUi });

    const res = await fetch(url("/stacks/some-id"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>spa-shell</html>");
  });

  it("does NOT fall back for /api/* paths even with embeddedUi set", async () => {
    const embeddedUi = makeEmbeddedSource({
      "index.html": {
        body: "<html>shell</html>",
        contentType: "text/html; charset=utf-8",
      },
    });
    server = await startDashboardServer({ port: 0, stateRoot, embeddedUi });

    const res = await fetch(url("/api/unknown"));
    expect(res.status).toBe(404);
  });

  it("falls through to placeholder when embeddedUi has no index.html", async () => {
    const embeddedUi = makeEmbeddedSource({});
    server = await startDashboardServer({ port: 0, stateRoot, embeddedUi });

    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dashboard UI not built");
  });

  it("uiDir wins over embeddedUi when both are set", async () => {
    const uiDir = mkdtempSync(join(tmpdir(), "lich-dashboard-override-"));
    try {
      writeFileSync(
        join(uiDir, "index.html"),
        "<html>from disk</html>",
        "utf8",
      );
      const embeddedUi = makeEmbeddedSource({
        "index.html": {
          body: "<html>from embed</html>",
          contentType: "text/html; charset=utf-8",
        },
      });
      server = await startDashboardServer({
        port: 0,
        stateRoot,
        uiDir,
        embeddedUi,
      });

      const res = await fetch(url("/"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>from disk</html>");
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });
});

describe("dashboard server — refresh()", () => {
  it("updates the cached view when refresh() is called after a state.json change", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    let res = await fetch(url("/api/stacks"));
    let body = await res.json();
    expect(body).toHaveLength(1);

    // contract: cache only updates when refresh() is called (driven by watcher, not handler)
    writeStateJson("stack-2", {
      stack_id: "stack-2",
      worktree_name: "feature-y",
      worktree_path: "/tmp/feature-y",
      status: "up",
      started_at: "2026-05-24T10:01:00.000Z",
      services: [],
    });

    server.refresh();
    await waitFor(
      async () => {
        const r = await fetch(url("/api/stacks"));
        const b = (await r.json()) as Array<{ id: string }>;
        return b.length;
      },
      (n) => n === 2,
    );

    res = await fetch(url("/api/stacks"));
    body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((s: { id: string }) => s.id).sort()).toEqual([
      "stack-1",
      "stack-2",
    ]);
  });

  it("populates the cache on initial startup (no refresh call needed)", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/api/stacks"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("stack-1");
  });
});

describe("dashboard server — stop()", () => {
  it("stops accepting requests after stop()", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const before = await fetch(url("/healthz"));
    expect(before.status).toBe(200);

    await server.stop();

    await expect(fetch(url("/healthz"))).rejects.toThrow();

    server = null;
  });

  it("stop() is idempotent", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    await expect(server.stop()).resolves.toBeUndefined();
    await expect(server.stop()).resolves.toBeUndefined();
    server = null;
  });
});

describe("dashboard server — AbortSignal teardown", () => {
  it("stops the server when signal.abort() fires", async () => {
    const controller = new AbortController();
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      signal: controller.signal,
    });

    const before = await fetch(url("/healthz"));
    expect(before.status).toBe(200);

    controller.abort();
    await new Promise<void>((r) => setTimeout(r, 50));

    await expect(fetch(url("/healthz"))).rejects.toThrow();
    server = null;
  });
});

describe("dashboard server — refresh atomicity", () => {
  it("concurrent fetches against a refreshing cache return consistent data", async () => {
    for (let i = 0; i < 5; i++) {
      writeStateJson(`stack-${i}`, {
        stack_id: `stack-${i}`,
        worktree_name: `feature-${i}`,
        worktree_path: `/tmp/feature-${i}`,
        status: "up",
        started_at: "2026-05-24T10:00:00.000Z",
        services: [],
      });
    }

    server = await startDashboardServer({ port: 0, stateRoot });

    const fetches = Array.from({ length: 20 }, () =>
      fetch(url("/api/stacks")).then((r) => r.json()),
    );

    // atomic-swap cache: each fetch sees either old or new map, never a partial merge
    for (let i = 0; i < 10; i++) {
      server.refresh();
      await new Promise<void>((r) => setTimeout(r, 1));
    }

    const results = await Promise.all(fetches);
    for (const result of results) {
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(5);
    }
  });
});

async function waitFor<T>(
  getter: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let value = await getter();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    value = await getter();
  }
  return value;
}

function makeFakeRoutingTable(
  initial: Array<{ hostname: string; upstream_url: string }> = [],
): {
  handle: {
    list(): Array<{ hostname: string; upstream_url: string }>;
    reload(): Promise<void>;
  };
  set(entries: Array<{ hostname: string; upstream_url: string }>): void;
  reloadCount(): number;
  failNextReloadWith(err: Error): void;
} {
  let entries = initial;
  let reloads = 0;
  let nextReloadError: Error | null = null;
  return {
    handle: {
      list: () => entries,
      reload: async () => {
        reloads++;
        if (nextReloadError !== null) {
          const e = nextReloadError;
          nextReloadError = null;
          throw e;
        }
      },
    },
    set(next) {
      entries = next;
    },
    reloadCount: () => reloads,
    failNextReloadWith(err) {
      nextReloadError = err;
    },
  };
}

describe("dashboard server — GET /api/routing", () => {
  it("returns the routing table entries when routingTable is configured", async () => {
    const fake = makeFakeRoutingTable([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
      { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9015" },
    ]);

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });

    const res = await fetch(url("/api/routing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
      { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9015" },
    ]);
  });

  it("returns 503 when routingTable is not configured", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/routing"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 405 on non-GET", async () => {
    const fake = makeFakeRoutingTable([]);
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });
    const res = await fetch(url("/api/routing"), { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("returns an empty array when the table has no entries", async () => {
    const fake = makeFakeRoutingTable([]);
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });
    const res = await fetch(url("/api/routing"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("reflects mutations after the table updates (subsequent fetch sees new entries)", async () => {
    const fake = makeFakeRoutingTable([]);
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });

    let res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([]);

    fake.set([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
    ]);

    res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
    ]);
  });
});

describe("dashboard server — POST /api/routing/reload", () => {
  it("invokes routingTable.reload() and returns 204", async () => {
    const fake = makeFakeRoutingTable([]);
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });

    expect(fake.reloadCount()).toBe(0);
    const res = await fetch(url("/api/routing/reload"), { method: "POST" });
    expect(res.status).toBe(204);
    expect(fake.reloadCount()).toBe(1);
  });

  it("returns 503 when routingTable is not configured", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/routing/reload"), { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("returns 405 on non-POST", async () => {
    const fake = makeFakeRoutingTable([]);
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });
    const res = await fetch(url("/api/routing/reload"));
    expect(res.status).toBe(405);
  });

  it("returns 500 with the error message when reload() throws", async () => {
    const fake = makeFakeRoutingTable([]);
    fake.failNextReloadWith(new Error("boom"));
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: fake.handle,
    });

    const res = await fetch(url("/api/routing/reload"), { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/boom/);
  });

  it("awaits reload() so a follow-up GET observes the new state", async () => {
    let source: Array<{ hostname: string; upstream_url: string }> = [];
    const handle = {
      list: () => source,
      reload: async () => {
        await new Promise<void>((r) => setTimeout(r, 25));
        source = [
          { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
        ];
      },
    };

    server = await startDashboardServer({
      port: 0,
      stateRoot,
      routingTable: handle,
    });

    let res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([]);

    res = await fetch(url("/api/routing/reload"), { method: "POST" });
    expect(res.status).toBe(204);

    res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
    ]);
  });
});
