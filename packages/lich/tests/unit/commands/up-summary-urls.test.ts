/**
 * Unit tests for `lich up`'s success-summary `urls:` block (LEV-481).
 *
 * The summary's URL list has four meaningful branches we pin here:
 *   1. Default + routing present       → friendly URLs (per-routing-entry)
 *   2. Default + no routing            → fall back to raw URLs (so the user
 *                                         always sees something when ports
 *                                         are allocated)
 *   3. `--raw` flag                    → raw URLs even when routing exists
 *   4. No ports anywhere               → empty `urls` block
 *
 * The tests call `buildSuccessSummary` (exported for this purpose) with
 * synthetic input — no orchestrator, no real services, no I/O. The other
 * fields of the summary block (services, lines, next) are tested
 * elsewhere; here we focus on the urls block.
 */

import { describe, expect, it } from "vitest";

import { buildSuccessSummary } from "../../../src/commands/up.js";
import type {
  RoutingEntry,
  ServiceSnapshot,
} from "../../../src/state/snapshot.js";

const baseInput = {
  stackId: "dogfood-stack-d0985055",
  worktreeName: "dogfood-stack",
  elapsedMs: 1234,
};

const apiService: ServiceSnapshot = {
  name: "api",
  kind: "owned",
  state: "ready",
  allocated_ports: { default: 9031 },
  pid: 1,
};

const webService: ServiceSnapshot = {
  name: "web",
  kind: "owned",
  state: "ready",
  allocated_ports: { default: 9032 },
  pid: 2,
};

const postgresService: ServiceSnapshot = {
  name: "postgres",
  kind: "compose",
  state: "ready",
  allocated_ports: { POSTGRES_HOST_PORT: 9020 },
};

const tunnelService: ServiceSnapshot = {
  name: "tunnel_demo",
  kind: "owned",
  state: "ready",
  pid: 3,
  // No allocated_ports — port-less service (e.g. a oneshot or background
  // process that doesn't expose anything).
};

const dogfoodRouting: RoutingEntry[] = [
  {
    hostname: "postgres.dogfood-stack",
    upstream_url: "http://127.0.0.1:9020",
    service: "postgres",
  },
  {
    hostname: "api.dogfood-stack",
    upstream_url: "http://127.0.0.1:9031",
    service: "api",
  },
  {
    hostname: "web.dogfood-stack",
    upstream_url: "http://127.0.0.1:9032",
    service: "web",
  },
];

// ---------------------------------------------------------------------------
// Default: friendly URLs from routing
// ---------------------------------------------------------------------------

describe("buildSuccessSummary — default URL block (friendly)", () => {
  it("emits friendly URLs derived from routing when raw=false and routing is present", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [postgresService, apiService, webService],
      routing: dogfoodRouting,
      proxyPort: 3300,
      raw: false,
    });
    expect(block.urls).toEqual([
      {
        service: "postgres",
        url: "http://postgres.dogfood-stack.lich.localhost:3300/",
      },
      {
        service: "api",
        url: "http://api.dogfood-stack.lich.localhost:3300/",
      },
      {
        service: "web",
        url: "http://web.dogfood-stack.lich.localhost:3300/",
      },
    ]);
  });

  it("uses the custom proxy port when supplied", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      routing: [
        {
          hostname: "api.wt",
          upstream_url: "http://127.0.0.1:9031",
          service: "api",
        },
      ],
      proxyPort: 4400,
      raw: false,
    });
    expect(block.urls).toEqual([
      { service: "api", url: "http://api.wt.lich.localhost:4400/" },
    ]);
  });

  it("preserves routing order in the urls block", async () => {
    // The summary block must mirror the routing table's order so users
    // reading the block top-to-bottom get the same sequence they'd see
    // from `lich urls`. Order matters for muscle memory.
    const block = buildSuccessSummary({
      ...baseInput,
      services: [webService, apiService, postgresService],
      routing: [
        {
          hostname: "web.wt",
          upstream_url: "x",
          service: "web",
        },
        {
          hostname: "api.wt",
          upstream_url: "x",
          service: "api",
        },
        {
          hostname: "postgres.wt",
          upstream_url: "x",
          service: "postgres",
        },
      ],
      proxyPort: 3300,
      raw: false,
    });
    expect(block.urls?.map((u) => u.service)).toEqual([
      "web",
      "api",
      "postgres",
    ]);
  });
});

// ---------------------------------------------------------------------------
// --raw: direct upstream URLs
// ---------------------------------------------------------------------------

describe("buildSuccessSummary — --raw URL block", () => {
  it("emits raw URLs (http://127.0.0.1:<port>) when raw=true", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [postgresService, apiService, webService],
      routing: dogfoodRouting,
      proxyPort: 3300,
      raw: true,
    });
    expect(block.urls).toEqual([
      { service: "postgres", url: "http://127.0.0.1:9020" },
      { service: "api", url: "http://127.0.0.1:9031" },
      { service: "web", url: "http://127.0.0.1:9032" },
    ]);
  });

  it("ignores routing entries entirely when raw=true (only reads allocated_ports)", async () => {
    // The `--raw` mode is a copy-paste of `lich urls --raw` semantics:
    // routing-table contents are irrelevant — only allocated_ports drive
    // what's printed. So a stack with a stale routing entry but no
    // matching allocated_ports would NOT print a URL for that hostname.
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      // Synthetic stale routing entry that doesn't match any service.
      routing: [
        {
          hostname: "ghost.wt",
          upstream_url: "http://127.0.0.1:99999",
          service: "ghost",
        },
      ],
      proxyPort: 3300,
      raw: true,
    });
    expect(block.urls).toEqual([
      { service: "api", url: "http://127.0.0.1:9031" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fallback: no routing → raw URLs from allocated_ports
// ---------------------------------------------------------------------------

describe("buildSuccessSummary — fallback to raw URLs when routing is empty", () => {
  it("falls back to raw URLs when raw=false but routing is undefined", async () => {
    // A stack where `buildRoutingEntries` produced [] (e.g. no service
    // declared a port) still has services in the snapshot. The summary
    // SHOULD still print URLs for any service with allocated_ports —
    // friendly URLs aren't possible (no routes), but raw URLs are.
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      // routing intentionally undefined.
      proxyPort: 3300,
      raw: false,
    });
    expect(block.urls).toEqual([
      { service: "api", url: "http://127.0.0.1:9031" },
    ]);
  });

  it("falls back to raw URLs when routing is the empty array", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      routing: [],
      proxyPort: 3300,
      raw: false,
    });
    expect(block.urls).toEqual([
      { service: "api", url: "http://127.0.0.1:9031" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Empty: no urls when no service has ports
// ---------------------------------------------------------------------------

describe("buildSuccessSummary — empty URL block", () => {
  it("omits urls when no service has allocated_ports", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [tunnelService],
      proxyPort: 3300,
      raw: false,
    });
    // Block.urls is undefined when there are no URLs — see the
    // `urls: urls.length > 0 ? urls : undefined` line in
    // buildSuccessSummary.
    expect(block.urls).toBeUndefined();
  });

  it("omits urls even when --raw and no service has allocated_ports", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [tunnelService],
      proxyPort: 3300,
      raw: true,
    });
    expect(block.urls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Other summary block fields — sanity that we didn't break them
// ---------------------------------------------------------------------------

describe("buildSuccessSummary — other block fields", () => {
  it("includes the stack id + worktree name in the lines block", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      proxyPort: 3300,
      raw: false,
    });
    expect(block.lines).toContain(`stack_id: ${baseInput.stackId}`);
    expect(block.lines).toContain(`worktree: ${baseInput.worktreeName}`);
  });

  it("emits the standard `next:` hints (`lich logs`, `lich down`)", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
      proxyPort: 3300,
      raw: false,
    });
    expect(block.next?.map((h) => h.cmd)).toEqual([
      "lich logs",
      "lich down",
    ]);
  });
});
