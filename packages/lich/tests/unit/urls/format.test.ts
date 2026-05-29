import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROXY_PORT,
  buildFriendlyUrls,
  buildRawUrls,
  extractKey,
  formatFriendlyUrl,
  formatUrlLine,
} from "../../../src/urls/format.js";
import type {
  RoutingEntry,
  ServiceSnapshot,
} from "../../../src/state/snapshot.js";

// ---------------------------------------------------------------------------
// formatFriendlyUrl + extractKey
// ---------------------------------------------------------------------------

describe("formatFriendlyUrl", () => {
  it("builds the friendly URL from a routing entry's hostname + proxy port", () => {
    const entry: RoutingEntry = {
      hostname: "api.feature-x",
      upstream_url: "http://127.0.0.1:9014",
      service: "api",
    };
    expect(formatFriendlyUrl(entry, 3300)).toBe(
      "http://api.feature-x.lich.localhost:3300/",
    );
  });

  it("substitutes the custom proxy port", () => {
    const entry: RoutingEntry = {
      hostname: "web.main",
      upstream_url: "http://127.0.0.1:8000",
      service: "web",
    };
    expect(formatFriendlyUrl(entry, 4400)).toBe(
      "http://web.main.lich.localhost:4400/",
    );
  });
});

describe("extractKey", () => {
  it("returns null for a single-port hostname (`<service>.<worktree>`)", () => {
    const entry: RoutingEntry = {
      hostname: "api.feature-x",
      upstream_url: "http://127.0.0.1:9000",
      service: "api",
    };
    expect(extractKey(entry)).toBeNull();
  });

  it("extracts the port key for a multi-port hostname (`<service>-<key>.<worktree>`)", () => {
    const entry: RoutingEntry = {
      hostname: "supabase-api.feature-x",
      upstream_url: "http://127.0.0.1:54321",
      service: "supabase",
    };
    expect(extractKey(entry)).toBe("api");
  });

  it("handles worktree names that contain dashes without mis-parsing the key", () => {
    // Regression guard: a naive splitter on `.` (with worktree-name like
    // `feature-x-test`) would chop the worktree name. The helper must
    // anchor on the `<service>-` prefix to detect multi-port shape.
    const entry: RoutingEntry = {
      hostname: "supabase-db.feature-x-test",
      upstream_url: "http://127.0.0.1:54322",
      service: "supabase",
    };
    expect(extractKey(entry)).toBe("db");
  });

  it("returns the trailing segment when the hostname lacks a dot suffix", () => {
    // Defensive: a hostname `service-key` with no worktree segment
    // shouldn't crash. We extract `key` verbatim.
    const entry: RoutingEntry = {
      hostname: "supabase-api",
      upstream_url: "http://127.0.0.1:54321",
      service: "supabase",
    };
    expect(extractKey(entry)).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// buildFriendlyUrls
// ---------------------------------------------------------------------------

describe("buildFriendlyUrls", () => {
  it("maps single-port routing entries to FormattedUrl without a key", () => {
    const routing: RoutingEntry[] = [
      {
        hostname: "api.feature-x",
        upstream_url: "http://127.0.0.1:9000",
        service: "api",
      },
    ];
    const out = buildFriendlyUrls(routing, 3300);
    expect(out).toEqual([
      {
        service: "api",
        url: "http://api.feature-x.lich.localhost:3300/",
      },
    ]);
  });

  it("maps multi-port routing entries to FormattedUrl with the key field set", () => {
    const routing: RoutingEntry[] = [
      {
        hostname: "supabase-api.wt",
        upstream_url: "http://127.0.0.1:54321",
        service: "supabase",
      },
      {
        hostname: "supabase-db.wt",
        upstream_url: "http://127.0.0.1:54322",
        service: "supabase",
      },
    ];
    const out = buildFriendlyUrls(routing, 3300);
    expect(out).toEqual([
      {
        service: "supabase",
        key: "api",
        url: "http://supabase-api.wt.lich.localhost:3300/",
      },
      {
        service: "supabase",
        key: "db",
        url: "http://supabase-db.wt.lich.localhost:3300/",
      },
    ]);
  });

  it("preserves input order — output[i] corresponds to routing[i]", () => {
    const routing: RoutingEntry[] = [
      { hostname: "web.wt", upstream_url: "x", service: "web" },
      { hostname: "api.wt", upstream_url: "x", service: "api" },
      { hostname: "postgres.wt", upstream_url: "x", service: "postgres" },
    ];
    const out = buildFriendlyUrls(routing, 3300);
    expect(out.map((u) => u.service)).toEqual(["web", "api", "postgres"]);
  });

  it("returns [] for an empty routing array", () => {
    expect(buildFriendlyUrls([], 3300)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildRawUrls
// ---------------------------------------------------------------------------

describe("buildRawUrls", () => {
  it("produces a single-port URL when allocated_ports has exactly one entry", () => {
    const services: ServiceSnapshot[] = [
      {
        name: "api",
        kind: "owned",
        state: "ready",
        allocated_ports: { default: 4001 },
        pid: 1,
      },
    ];
    const out = buildRawUrls(services);
    expect(out).toEqual([
      { service: "api", url: "http://127.0.0.1:4001" },
    ]);
  });

  it("produces one entry per port (with key) when allocated_ports has multiple entries", () => {
    const services: ServiceSnapshot[] = [
      {
        name: "supabase",
        kind: "owned",
        state: "ready",
        allocated_ports: { api: 54321, db: 54322 },
        pid: 1,
      },
    ];
    const out = buildRawUrls(services);
    expect(out).toEqual([
      { service: "supabase", key: "api", url: "http://127.0.0.1:54321" },
      { service: "supabase", key: "db", url: "http://127.0.0.1:54322" },
    ]);
  });

  it("skips services without allocated_ports", () => {
    const services: ServiceSnapshot[] = [
      { name: "migrator", kind: "owned", state: "ready", pid: 1 },
      {
        name: "api",
        kind: "owned",
        state: "ready",
        allocated_ports: { default: 4001 },
        pid: 2,
      },
    ];
    const out = buildRawUrls(services);
    expect(out).toEqual([
      { service: "api", url: "http://127.0.0.1:4001" },
    ]);
  });

  it("returns [] when no service has allocated ports", () => {
    const services: ServiceSnapshot[] = [
      { name: "migrator", kind: "owned", state: "ready", pid: 1 },
    ];
    expect(buildRawUrls(services)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatUrlLine
// ---------------------------------------------------------------------------

describe("formatUrlLine", () => {
  it("formats single-port entries without a key suffix in either style", () => {
    const url = {
      service: "api",
      url: "http://api.wt.lich.localhost:3300/",
    };
    expect(formatUrlLine(url, "friendly")).toBe(
      "api: http://api.wt.lich.localhost:3300/",
    );
    expect(formatUrlLine(url, "raw")).toBe(
      "api: http://api.wt.lich.localhost:3300/",
    );
  });

  it("formats multi-port entries with ` (<key>)` in friendly style", () => {
    const url = {
      service: "supabase",
      key: "api",
      url: "http://supabase-api.wt.lich.localhost:3300/",
    };
    expect(formatUrlLine(url, "friendly")).toBe(
      "supabase (api): http://supabase-api.wt.lich.localhost:3300/",
    );
  });

  it("formats multi-port entries with `.<key>` in raw style", () => {
    const url = {
      service: "supabase",
      key: "api",
      url: "http://127.0.0.1:54321",
    };
    expect(formatUrlLine(url, "raw")).toBe(
      "supabase.api: http://127.0.0.1:54321",
    );
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PROXY_PORT
// ---------------------------------------------------------------------------

describe("DEFAULT_PROXY_PORT", () => {
  it("is 3300 — the daemon's default proxy port", () => {
    expect(DEFAULT_PROXY_PORT).toBe(3300);
  });
});
