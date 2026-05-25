/**
 * Unit tests for the daemon's routing table (LEV-413, Plan 5 Task 11).
 *
 * The routing table reads every per-stack `state.json` under the state
 * root, harvests their `routing` arrays, and exposes case-insensitive
 * hostname lookup. These tests cover:
 *
 *   1. Empty stateRoot (and missing-entirely stateRoot) → empty table.
 *   2. Single state.json round-trip via `get()`.
 *   3. Multiple state.json files merge into one table.
 *   4. Collisions: last writer wins (deterministic on a fresh reload).
 *   5. Case-insensitive lookup (RFC 9110).
 *   6. State.json without a `routing` field is silently ignored.
 *   7. Malformed state.json is silently ignored (logged, never thrown).
 *   8. `reload()` picks up file changes.
 *   9. Stacks with status `stopped` / `failed` are excluded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoutingTable } from "../../../../src/daemon/proxy/routing.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Each test gets a fresh tmpdir as `stateRoot`. We never touch the real
// `~/.lich/stacks` — the tests build their own per-stack directory layout
// and feed the resulting path into `reload()`.
// ---------------------------------------------------------------------------

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-proxy-routing-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

/**
 * Write a synthetic state.json for a stack. We don't go through the
 * real `writeSnapshot` helper because that requires `LICH_HOME` plumbing
 * and we want this fixture to be independent of the snapshot module's
 * exact layout — it just has to match what the routing reader expects.
 */
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

// ---------------------------------------------------------------------------
// 1. Empty / missing stateRoot
// ---------------------------------------------------------------------------

describe("RoutingTable.reload — empty / missing stateRoot", () => {
  it("returns empty table for an empty stateRoot", async () => {
    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
    expect(table.get("api.feature-x")).toBeUndefined();
  });

  it("returns empty table when stateRoot does not exist", async () => {
    // Fresh-install scenario: <LICH_HOME>/stacks doesn't exist yet.
    // `reload()` must tolerate this without throwing — the daemon has
    // legitimate reasons to call us before any `lich up` has run.
    const missing = join(stateRoot, "does-not-exist");
    const table = new RoutingTable();
    await expect(table.reload(missing)).resolves.toBeUndefined();
    expect(table.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Single state.json with one routing entry
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. Multiple state.json files
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 4. Hostname collision: last reload wins
// ---------------------------------------------------------------------------

describe("RoutingTable.reload — hostname collisions", () => {
  it("uses last-writer-wins semantics on a fresh reload", async () => {
    // Two stacks both claim `api.feature-x`. Filesystem order
    // (`readdir`) is the tiebreaker; we don't pretend to make it
    // deterministic across runs, but a single `reload()` always
    // observes ONE winner, never a mixture, and a subsequent reload
    // produces the same result given the same on-disk state.
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

    // Single entry — collapsed by the Map.
    expect(table.size()).toBe(1);
    // Whichever URL won, it must be one of the two we wrote.
    const winner = table.get("api.feature-x");
    expect([
      "http://127.0.0.1:9001",
      "http://127.0.0.1:9002",
    ]).toContain(winner);

    // And the winner must be stable across consecutive reloads with
    // unchanged on-disk state.
    const firstWinner = winner;
    await table.reload(stateRoot);
    expect(table.get("api.feature-x")).toBe(firstWinner);
  });
});

// ---------------------------------------------------------------------------
// 5. Case-insensitive lookup
// ---------------------------------------------------------------------------

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

    // Browser sends `Host: API.FEATURE-X.lich.localhost`. After the
    // proxy strips the suffix it asks us for `API.FEATURE-X` — that
    // must match the lowercase entry we indexed.
    expect(table.get("API.FEATURE-X")).toBe("http://127.0.0.1:9014");
    expect(table.get("Api.Feature-X")).toBe("http://127.0.0.1:9014");
    expect(table.get("api.feature-x")).toBe("http://127.0.0.1:9014");
  });

  it("normalizes mixed-case stored hostnames to lowercase too", async () => {
    // Belt-and-suspenders: even if a snapshot somehow carries an
    // uppercase hostname (a third-party tool wrote it, or a future
    // bug), lookup still works.
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

// ---------------------------------------------------------------------------
// 6. State.json without `routing` field is ignored
// ---------------------------------------------------------------------------

describe("RoutingTable.reload — snapshots without `routing`", () => {
  it("ignores a snapshot missing the routing field (pre-Plan-5 layout)", async () => {
    // A pre-Plan-5 snapshot. `routing` field is genuinely absent.
    // The reader must tolerate it without contributing any entries
    // and without raising an error.
    writeStateJson("stack-1", { status: "up" });

    const table = new RoutingTable();
    await expect(table.reload(stateRoot)).resolves.toBeUndefined();
    expect(table.size()).toBe(0);
  });

  it("ignores an empty `routing: []` (just-torn-down stack)", async () => {
    // `lich down` clears the array but keeps the field. The reader
    // contributes nothing, no error.
    writeStateJson("stack-1", { status: "up", routing: [] });

    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed state.json is ignored
// ---------------------------------------------------------------------------

describe("RoutingTable.reload — malformed state.json", () => {
  it("ignores a state.json that is not valid JSON (logs, does not throw)", async () => {
    // A truncated / garbage state.json must not crash the routing
    // table. We log a warning so an operator notices, but the rest
    // of the stacks on the machine still get indexed.
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

    // The good stack still contributed.
    expect(table.size()).toBe(1);
    expect(table.get("api.main")).toBe("http://127.0.0.1:9001");

    // The broken one was logged.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores entries with missing hostname or upstream_url fields", async () => {
    // Structural malformation INSIDE an otherwise parseable doc —
    // we don't crash, we just skip the bad entry. The good sibling
    // entry still wins.
    writeStateJson("stack-1", {
      status: "up",
      routing: [
        // @ts-expect-error — intentional shape violation in the
        // fixture; the reader treats this as "skip" rather than throw.
        { upstream_url: "http://127.0.0.1:9001" }, // no hostname
        // @ts-expect-error — same idea, no upstream_url.
        { hostname: "api.main" }, // no upstream_url
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

// ---------------------------------------------------------------------------
// 8. Reload picks up changes
// ---------------------------------------------------------------------------

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

    // Rewrite — port shifted (e.g. user restarted the stack).
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
    // `lich down` rewrites the snapshot with `routing: []`. The reload
    // should drop the previously-indexed routes — otherwise stale
    // entries point at no-longer-running upstreams.
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

// ---------------------------------------------------------------------------
// 9. Status filter (stopped / failed stacks are excluded)
// ---------------------------------------------------------------------------

describe("RoutingTable.reload — status filter", () => {
  it("excludes routes from a stack with status=stopped", async () => {
    // A stopped stack's listed ports aren't bound to anything. The
    // proxy should miss on those routes (404) rather than try to
    // forward and get connection-refused.
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

// ---------------------------------------------------------------------------
// 10. LEV-480: RoutingTable.list() — snapshot for diagnostic use
// ---------------------------------------------------------------------------

describe("RoutingTable.list — diagnostic snapshot", () => {
  it("returns an empty array when the table has no entries", async () => {
    const table = new RoutingTable();
    await table.reload(stateRoot);
    expect(table.list()).toEqual([]);
  });

  it("returns entries sorted by hostname for deterministic output", async () => {
    // Write three stacks so the underlying Map's insertion order is
    // NOT already alphabetical (postgres first, then api, then web).
    // The list() result MUST be sorted by hostname regardless of
    // insertion order — `lich routing` and snapshot tests rely on it.
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

    // Now clear the on-disk state and reload — the in-memory table
    // becomes empty, but the previously-captured snapshot stays.
    writeStateJson("stack-1", { status: "stopped", routing: [] });
    await table.reload(stateRoot);
    expect(table.size()).toBe(0);
    // Snapshot didn't mutate under the caller.
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].hostname).toBe("api.feature-x");
  });
});
