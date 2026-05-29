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
  // port-less service
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
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
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

describe("buildSuccessSummary — fallback to raw URLs when routing is empty", () => {
  it("falls back to raw URLs when raw=false but routing is undefined", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [apiService],
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

describe("buildSuccessSummary — empty URL block", () => {
  it("omits urls when no service has allocated_ports", async () => {
    const block = buildSuccessSummary({
      ...baseInput,
      services: [tunnelService],
      proxyPort: 3300,
      raw: false,
    });
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
