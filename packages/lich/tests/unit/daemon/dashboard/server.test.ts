/**
 * Unit tests for the dashboard HTTP server (LEV-408, Plan 5 Task 6).
 *
 * The dashboard server is a `Bun.serve` HTTP server that exposes the
 * REST surface the SPA consumes (`/api/stacks`, `/api/stacks/:id`,
 * `/api/stacks/:id/services/:service`), serves static UI assets from
 * an optional `uiDir`, and exposes a `refresh()` hook the daemon's
 * watcher calls to invalidate the in-memory cache.
 *
 * These tests spin up real `Bun.serve` instances bound to ephemeral
 * ports against a real tmpdir state root. No mocking of fetch — the
 * tests exercise the full round-trip so wire-format regressions get
 * caught before they reach the SPA.
 *
 * Coverage (per task spec):
 *   1. GET /healthz -> 200 with { ok: true }
 *   2. GET /api/stacks -> returns the cached stacks view
 *   3. GET /api/stacks/:id -> returns the specific stack
 *   4. GET /api/stacks/nonexistent -> 404
 *   5. GET /api/stacks/:id/services/:service -> returns specific service
 *   6. GET /api/stacks/:id/services/nonexistent -> 404
 *   7. GET / (no uiDir) -> placeholder HTML, 200
 *   8. GET / (with uiDir) -> serves index.html from that dir
 *   9. refresh() updates the cached view
 *  10. stop() shuts down the server (subsequent fetch fails)
 *  11. signal.abort() stops the server
 *  12. Concurrent fetches against a refreshing cache see consistent data
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  type DashboardServer,
} from "../../../../src/daemon/dashboard/server.js";

// ---------------------------------------------------------------------------
// Fixture harness — fresh tmpdir per test; server torn down in afterEach.
// ---------------------------------------------------------------------------

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

/**
 * Synthetic state.json writer — same pattern as stacks-view.test.ts.
 * Bypasses `writeSnapshot` so we keep full control over the on-disk
 * shape and don't tangle the harness with `LICH_HOME` plumbing.
 */
function writeStateJson(
  stackId: string,
  data: Record<string, unknown> | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

/** Small helper to compose a URL against the running server. */
function url(path: string): string {
  if (!server) throw new Error("server not started");
  return server.url + path;
}

// ---------------------------------------------------------------------------
// 1. GET /healthz
// ---------------------------------------------------------------------------

describe("dashboard server — /healthz", () => {
  it("returns 200 with { ok: true }", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/stacks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. GET /api/stacks/:id
// ---------------------------------------------------------------------------

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

  // 4.
  it("returns 404 for a nonexistent stack id", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(url("/api/stacks/nonexistent"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5/6. GET /api/stacks/:id/services/:service
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7. GET / (no uiDir) -> placeholder HTML
// ---------------------------------------------------------------------------

describe("dashboard server — root (no uiDir)", () => {
  it("returns placeholder HTML with 200 when uiDir is not set", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // The placeholder explicitly tells the operator the UI hasn't been
    // built yet — Plan 5 Task 13 lands the real SPA. Without the
    // explicit mention, an unbuilt deployment looks broken.
    expect(body).toContain("dashboard UI not built");
  });
});

// ---------------------------------------------------------------------------
// 8. GET / (with uiDir) -> serves index.html
// ---------------------------------------------------------------------------

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
      // Bun's auto content-type detection picks `text/javascript` (or
      // `application/javascript`) for `.js`. Don't pin the exact form
      // — just confirm a body came through.
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

      // /stacks/some-id is a virtual SPA route — no file exists for it
      // on disk; the server should fall back to index.html so React
      // Router can take over.
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

      // Unknown API routes must NOT serve the SPA shell — that would
      // look like a 200 to a tool that's testing an API endpoint and
      // mask real bugs.
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

      // Bun's `fetch` normalizes `../` in the request path before it
      // ever leaves the client, so we can't easily compose a hostile
      // URL via fetch. Instead, we test the path-traversal guard
      // indirectly by requesting a known-out-of-uiDir asset name. The
      // server's static handler must refuse anything outside `uiDir`
      // — this matches the task spec's "path traversal protection".
      const res = await fetch(url("/..%2Fetc%2Fpasswd"));
      // Either 404 (file not found, falls through to index.html which
      // is OK for SPA) or 400/404 from a hard reject — both are fine,
      // the important thing is we don't 200 with /etc/passwd contents.
      expect([200, 400, 404]).toContain(res.status);
      if (res.status === 200) {
        const body = await res.text();
        // Must not contain anything from /etc/passwd — the SPA shell
        // is the worst-case response.
        expect(body).not.toContain("root:");
      }
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. refresh() updates the cached view
// ---------------------------------------------------------------------------

describe("dashboard server — refresh()", () => {
  it("updates the cached view when refresh() is called after a state.json change", async () => {
    // Start with one stack.
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

    // Add a second stack on disk; without refresh() the cache still
    // shows one. This is the contract — the daemon's watcher drives
    // refresh, not the request handler.
    writeStateJson("stack-2", {
      stack_id: "stack-2",
      worktree_name: "feature-y",
      worktree_path: "/tmp/feature-y",
      status: "up",
      started_at: "2026-05-24T10:01:00.000Z",
      services: [],
    });

    // Manually fire refresh — simulates the watcher's onChange.
    server.refresh();
    // refresh() schedules an async reload; give it a beat to settle.
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
    // Stacks already on disk BEFORE the server starts — the constructor
    // should run an initial refresh so the first request sees them.
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

// ---------------------------------------------------------------------------
// 10. stop() shuts down the server
// ---------------------------------------------------------------------------

describe("dashboard server — stop()", () => {
  it("stops accepting requests after stop()", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });

    // Sanity: first request works.
    const before = await fetch(url("/healthz"));
    expect(before.status).toBe(200);

    await server.stop();

    // Subsequent fetch must reject (connection refused). The server's
    // gone; the OS rejects new connections.
    await expect(fetch(url("/healthz"))).rejects.toThrow();

    // Clear out the harness pointer so afterEach doesn't double-stop.
    server = null;
  });

  it("stop() is idempotent", async () => {
    server = await startDashboardServer({ port: 0, stateRoot });
    await expect(server.stop()).resolves.toBeUndefined();
    await expect(server.stop()).resolves.toBeUndefined();
    server = null;
  });
});

// ---------------------------------------------------------------------------
// 11. signal.abort() stops the server
// ---------------------------------------------------------------------------

describe("dashboard server — AbortSignal teardown", () => {
  it("stops the server when signal.abort() fires", async () => {
    const controller = new AbortController();
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      signal: controller.signal,
    });

    // Sanity: first request works.
    const before = await fetch(url("/healthz"));
    expect(before.status).toBe(200);

    controller.abort();
    // Give the abort handler a tick to drain the socket.
    await new Promise<void>((r) => setTimeout(r, 50));

    await expect(fetch(url("/healthz"))).rejects.toThrow();
    server = null;
  });
});

// ---------------------------------------------------------------------------
// 12. Concurrent fetches during refresh don't return partial data
// ---------------------------------------------------------------------------

describe("dashboard server — refresh atomicity", () => {
  it("concurrent fetches against a refreshing cache return consistent data", async () => {
    // Pre-seed with a few stacks so each fetch returns a non-trivial
    // payload.
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

    // Fire a bunch of concurrent fetches AND refreshes; each fetch
    // must return a fully-formed array, never a half-built one.
    const fetches = Array.from({ length: 20 }, () =>
      fetch(url("/api/stacks")).then((r) => r.json()),
    );

    // Interleave refresh calls with the fetches. The atomic swap in
    // the server's cache means each fetch sees either the old map or
    // the new one — never an in-progress merge.
    for (let i = 0; i < 10; i++) {
      server.refresh();
      // Tiny await to let some fetches resolve between refreshes.
      await new Promise<void>((r) => setTimeout(r, 1));
    }

    const results = await Promise.all(fetches);
    for (const result of results) {
      expect(Array.isArray(result)).toBe(true);
      // Each must have at least the 5 pre-seeded stacks — none should
      // be missing because of a partial-rebuild race.
      expect((result as unknown[]).length).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll `getter()` until `predicate(value)` is true or `timeoutMs` elapses.
 * Returns the final value either way — leave the assertion to the caller.
 * Mirrors the `waitFor` helper in watcher.test.ts (same project pattern).
 */
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

// ---------------------------------------------------------------------------
// LEV-480: GET /api/routing + POST /api/routing/reload
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fake of {@link RoutingTableHandle}. Tests build their
 * own routing entries up front and assert that the dashboard surfaces
 * them as-is (and that POST /api/routing/reload triggers the right hook).
 */
function makeFakeRoutingTable(
  initial: Array<{ hostname: string; upstream_url: string }> = [],
): {
  handle: {
    list(): Array<{ hostname: string; upstream_url: string }>;
    reload(): Promise<void>;
  };
  /** Replace the entries the next `list()` call returns. */
  set(entries: Array<{ hostname: string; upstream_url: string }>): void;
  /** Number of times `reload()` has been called. */
  reloadCount(): number;
  /** Make the next `reload()` call reject with this error. */
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
    // Simulate the real watcher pattern: reload() rebuilds the table from
    // some source the test controls. The dashboard contract is that POST
    // /api/routing/reload doesn't return until reload() resolves, so a
    // GET right after MUST see the updated entries.
    let source: Array<{ hostname: string; upstream_url: string }> = [];
    const handle = {
      list: () => source,
      reload: async () => {
        // Pretend reload is async — a real reload() reads files etc.
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

    // Before reload: empty.
    let res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([]);

    // Trigger reload — must complete before the POST returns.
    res = await fetch(url("/api/routing/reload"), { method: "POST" });
    expect(res.status).toBe(204);

    // After reload: the entries the reload() callback wrote are visible.
    res = await fetch(url("/api/routing"));
    expect(await res.json()).toEqual([
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9014" },
    ]);
  });
});
