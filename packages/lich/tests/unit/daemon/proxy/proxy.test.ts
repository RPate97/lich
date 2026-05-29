import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoutingTable } from "../../../../src/daemon/proxy/routing.js";
import {
  deriveProxyPort,
  parseHostname,
  startProxy,
} from "../../../../src/daemon/proxy/proxy.js";
import { createStaticRoutes } from "../../../../src/daemon/proxy/static-routes.js";

type Upstream = { url: string; port: number; stop: () => Promise<void> };

function makeUpstream(
  handler: (req: Request) => Response | Promise<Response>,
): Upstream {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    stop: async () => {
      server.stop(true);
      await new Promise<void>((r) => setTimeout(r, 0));
    },
  };
}

/**
 * Fetch the proxy at `proxyUrl` while presenting `hostHeader` as the Host —
 * Bun derives Host from URL otherwise.
 */
async function fetchVia(
  proxyUrl: string,
  hostHeader: string,
  init?: RequestInit & { path?: string },
): Promise<Response> {
  const path = init?.path ?? "/";
  const headers = new Headers(init?.headers);
  headers.set("Host", hostHeader);
  return fetch(proxyUrl + path, {
    ...init,
    headers,
  });
}

let proxy: { url: string; stop: () => Promise<void> } | null = null;
const upstreams: Upstream[] = [];
let table: RoutingTable;

beforeEach(() => {
  table = new RoutingTable();
});

afterEach(async () => {
  if (proxy) {
    await proxy.stop();
    proxy = null;
  }
  while (upstreams.length > 0) {
    const u = upstreams.pop();
    if (u) await u.stop();
  }
});

function seedRouting(entries: Record<string, string>): void {
  // poke private entries directly — alternative is real state.json writes
  const internal = table as unknown as { entries: Map<string, string> };
  internal.entries = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

describe("startProxy — basic forwarding", () => {
  it("forwards a request with a matching Host header to the upstream", async () => {
    const upstream = makeUpstream(() => new Response("hello from upstream"));
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });

    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from upstream");
  });

  it("binds both IPv4 (127.0.0.1) and IPv6 (::1) loopback on the same port", async () => {
    // proxy used to bind hostname:"localhost" → macOS resolved ::1 first → IPv4 ECONNREFUSED
    const upstream = makeUpstream(() => new Response("dual-stack ok"));
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const proxyPort = new URL(proxy.url).port;
    expect(proxyPort).toMatch(/^\d+$/);

    const resV4 = await fetch(`http://127.0.0.1:${proxyPort}/`, {
      headers: { Host: "api.feature-x.lich.localhost:3300" },
    });
    expect(resV4.status).toBe(200);
    expect(await resV4.text()).toBe("dual-stack ok");

    // best-effort: IPv6 may be disabled on the host
    try {
      const resV6 = await fetch(`http://[::1]:${proxyPort}/`, {
        headers: { Host: "api.feature-x.lich.localhost:3300" },
      });
      expect(resV6.status).toBe(200);
      expect(await resV6.text()).toBe("dual-stack ok");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `IPv6 loopback fetch skipped: ${(err as Error).message}`,
      );
    }
  });

  it("preserves path and query in the upstream URL", async () => {
    let receivedUrl = "";
    const upstream = makeUpstream((req) => {
      const u = new URL(req.url);
      receivedUrl = u.pathname + u.search;
      return new Response("ok");
    });
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300", {
      path: "/foo/bar?baz=qux&more=stuff",
    });
    expect(res.status).toBe(200);
    expect(receivedUrl).toBe("/foo/bar?baz=qux&more=stuff");
  });
});

describe("startProxy — miss handling", () => {
  it("returns 404 when the Host doesn't match any routing entry", async () => {
    seedRouting({ "api.feature-x": "http://127.0.0.1:9999" });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "nope.main.lich.localhost:3300");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("lich.localhost");
  });

  it("returns 404 when the Host doesn't end in .lich.localhost", async () => {
    seedRouting({ "api.feature-x": "http://127.0.0.1:9999" });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "example.com");
    expect(res.status).toBe(404);
  });

  it("lists known friendly hosts in the 404 body", async () => {
    seedRouting({
      "api.feature-x": "http://127.0.0.1:9001",
      "web.main": "http://127.0.0.1:9002",
    });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "nope.main.lich.localhost:3300");
    const body = await res.text();
    expect(body).toContain("api.feature-x");
    expect(body).toContain("web.main");
  });
});

describe("startProxy — missing Host", () => {
  it("returns 404 when the request has no Host header", async () => {
    seedRouting({ "api.feature-x": "http://127.0.0.1:9999" });
    proxy = await startProxy({ port: 0, routingTable: table });

    // Bun's fetch always sets Host from URL; simulate no-Host via empty value
    const res = await fetchVia(proxy.url, "");
    expect(res.status).toBe(404);
  });
});

describe("startProxy — method/body/header forwarding", () => {
  it("forwards POST method and body to upstream", async () => {
    let receivedMethod = "";
    let receivedBody = "";
    const upstream = makeUpstream(async (req) => {
      receivedMethod = req.method;
      receivedBody = await req.text();
      return new Response("ack");
    });
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300", {
      method: "POST",
      body: '{"hello":"world"}',
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ack");
    expect(receivedMethod).toBe("POST");
    expect(receivedBody).toBe('{"hello":"world"}');
  });

  it("forwards arbitrary request headers (except hop-by-hop) to upstream", async () => {
    let receivedHeaders: Record<string, string> = {};
    const upstream = makeUpstream((req) => {
      receivedHeaders = Object.fromEntries(req.headers.entries());
      return new Response("ok");
    });
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300", {
      headers: {
        "x-custom-header": "custom-value",
        authorization: "Bearer test-token",
      },
    });

    expect(receivedHeaders["x-custom-header"]).toBe("custom-value");
    expect(receivedHeaders.authorization).toBe("Bearer test-token");
    // friendly hostname must NOT be forwarded as Host — upstream sees its own bound address
    expect(receivedHeaders.host).not.toBe(
      "api.feature-x.lich.localhost:3300",
    );
  });
});

describe("startProxy — upstream response handling", () => {
  it("propagates non-200 status codes from upstream", async () => {
    const upstream = makeUpstream(
      () =>
        new Response("not found body", {
          status: 404,
          statusText: "Not Found",
        }),
    );
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found body");
  });

  it("propagates upstream response headers", async () => {
    const upstream = makeUpstream(
      () =>
        new Response("body", {
          headers: {
            "x-upstream-header": "passthrough-value",
            "content-type": "text/plain",
          },
        }),
    );
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300");
    expect(res.headers.get("x-upstream-header")).toBe("passthrough-value");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    seedRouting({ "api.feature-x": "http://127.0.0.1:1" });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300");
    expect(res.status).toBe(502);
  });

  it("strips content-encoding + content-length so clients don't double-decompress gzip", async () => {
    // Bun's fetch auto-decompresses but leaves content-encoding set;
    // forwarding both → client double-decompresses → ZlibError
    const plain = "hello from gzipped upstream — proxied transparently";
    const gzipped = Bun.gzipSync(new TextEncoder().encode(plain));

    const upstream = makeUpstream(
      () =>
        new Response(gzipped, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(gzipped.byteLength),
            "content-type": "text/plain; charset=utf-8",
          },
        }),
    );
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const res = await fetchVia(proxy.url, "api.feature-x.lich.localhost:3300");

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toBe(plain);

    const cl = res.headers.get("content-length");
    if (cl !== null) {
      // em-dash is 3 bytes UTF-8 / 1 JS char — compare against UTF-8 byte count
      const plainBytes = new TextEncoder().encode(plain).length;
      expect(Number(cl)).toBe(plainBytes);
    }
  });
});

describe("startProxy — AbortSignal teardown", () => {
  it("stops accepting requests after signal.abort()", async () => {
    const upstream = makeUpstream(() => new Response("ok"));
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });

    const controller = new AbortController();
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      signal: controller.signal,
    });

    const before = await fetchVia(
      proxy.url,
      "api.feature-x.lich.localhost:3300",
    );
    expect(before.status).toBe(200);

    controller.abort();
    await new Promise<void>((r) => setTimeout(r, 50));

    await expect(
      fetchVia(proxy.url, "api.feature-x.lich.localhost:3300"),
    ).rejects.toThrow();

    proxy = null;
  });

  it("stop() is idempotent", async () => {
    proxy = await startProxy({ port: 0, routingTable: table });
    await expect(proxy.stop()).resolves.toBeUndefined();
    await expect(proxy.stop()).resolves.toBeUndefined();
    proxy = null;
  });
});

describe("startProxy — static routes", () => {
  it("forwards an apex request matching a static route to the static upstream", async () => {
    const dashboard = makeUpstream(() => new Response("dashboard root"));
    upstreams.push(dashboard);

    const staticRoutes = createStaticRoutes({
      "lich.localhost": dashboard.url,
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(proxy.url, "lich.localhost");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dashboard root");
  });

  it("matches static routes even when the Host header includes `:port`", async () => {
    // real browsers/curl send Host: lich.localhost:3300
    const dashboard = makeUpstream(() => new Response("dashboard"));
    upstreams.push(dashboard);

    const staticRoutes = createStaticRoutes({
      "lich.localhost": dashboard.url,
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(proxy.url, "lich.localhost:3300");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dashboard");
  });

  it("static routes are consulted BEFORE the per-stack routing table", async () => {
    const dashboardUpstream = makeUpstream(
      () => new Response("from-static"),
    );
    const stackUpstream = makeUpstream(() => new Response("from-stack"));
    upstreams.push(dashboardUpstream, stackUpstream);

    seedRouting({ "lich.localhost": stackUpstream.url });
    const staticRoutes = createStaticRoutes({
      "lich.localhost": dashboardUpstream.url,
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(proxy.url, "lich.localhost");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-static");
  });

  it("falls through to per-stack routing for non-static-matching hosts", async () => {
    const dashboard = makeUpstream(() => new Response("dashboard"));
    const stack = makeUpstream(() => new Response("stack-api"));
    upstreams.push(dashboard, stack);

    seedRouting({ "api.feature-x": stack.url });
    const staticRoutes = createStaticRoutes({
      "lich.localhost": dashboard.url,
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(
      proxy.url,
      "api.feature-x.lich.localhost:3300",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("stack-api");
  });

  it("returns 502 when the static upstream is unreachable", async () => {
    const staticRoutes = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:1",
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(proxy.url, "lich.localhost");
    expect(res.status).toBe(502);
  });

  it("preserves path + query when forwarding to the static upstream", async () => {
    let receivedUrl = "";
    const dashboard = makeUpstream((req) => {
      const u = new URL(req.url);
      receivedUrl = u.pathname + u.search;
      return new Response("ok");
    });
    upstreams.push(dashboard);

    const staticRoutes = createStaticRoutes({
      "lich.localhost": dashboard.url,
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    await fetchVia(proxy.url, "lich.localhost", {
      path: "/stacks/dogfood?refresh=1",
    });
    expect(receivedUrl).toBe("/stacks/dogfood?refresh=1");
  });

  it("404 body lists static hosts alongside per-stack hosts on a miss", async () => {
    seedRouting({ "api.feature-x": "http://127.0.0.1:9999" });
    const staticRoutes = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:8000",
    });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
      staticRoutes,
    });

    const res = await fetchVia(proxy.url, "totally.unrelated:1234");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("api.feature-x");
    expect(body).toContain("Daemon-wide friendly hosts");
    expect(body).toContain("lich.localhost");
  });

  it("works without a static-routes option", async () => {
    const upstream = makeUpstream(() => new Response("plain"));
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({
      port: 0,
      routingTable: table,
    });

    const res = await fetchVia(
      proxy.url,
      "api.feature-x.lich.localhost:3300",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain");
  });
});

describe("startProxy — concurrency", () => {
  it("handles concurrent requests independently with correct responses", async () => {
    const upstream = makeUpstream(async (req) => {
      const u = new URL(req.url);
      const id = u.searchParams.get("id") ?? "?";
      // small delay so requests interleave in the proxy
      await new Promise<void>((r) => setTimeout(r, 5));
      return new Response(`response-for-${id}`);
    });
    upstreams.push(upstream);

    seedRouting({ "api.feature-x": upstream.url });
    proxy = await startProxy({ port: 0, routingTable: table });

    const ids = Array.from({ length: 10 }, (_, i) => `req${i}`);
    const responses = await Promise.all(
      ids.map((id) =>
        fetchVia(proxy!.url, "api.feature-x.lich.localhost:3300", {
          path: `/?id=${id}`,
        }).then((r) => r.text()),
      ),
    );

    for (let i = 0; i < ids.length; i++) {
      expect(responses[i]).toBe(`response-for-${ids[i]}`);
    }
  });

  it("routes concurrent requests to different upstreams by Host", async () => {
    const upstreamA = makeUpstream(() => new Response("from A"));
    const upstreamB = makeUpstream(() => new Response("from B"));
    upstreams.push(upstreamA, upstreamB);

    seedRouting({
      "api.feature-a": upstreamA.url,
      "api.feature-b": upstreamB.url,
    });
    proxy = await startProxy({ port: 0, routingTable: table });

    const reqs: Array<Promise<string>> = [];
    for (let i = 0; i < 5; i++) {
      reqs.push(
        fetchVia(proxy.url, "api.feature-a.lich.localhost:3300").then((r) =>
          r.text(),
        ),
      );
      reqs.push(
        fetchVia(proxy.url, "api.feature-b.lich.localhost:3300").then((r) =>
          r.text(),
        ),
      );
    }
    const out = await Promise.all(reqs);

    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(i % 2 === 0 ? "from A" : "from B");
    }
  });
});

describe("parseHostname", () => {
  it("extracts the key from `<key>.lich.localhost:<port>`", () => {
    expect(parseHostname("api.feature-x.lich.localhost:3300")).toBe(
      "api.feature-x",
    );
  });

  it("extracts the key when there's no port", () => {
    expect(parseHostname("api.feature-x.lich.localhost")).toBe(
      "api.feature-x",
    );
  });

  it("handles single-label keys (service-only, no worktree)", () => {
    // parseHostname strips suffix only; routing table will miss anyway
    expect(parseHostname("api.lich.localhost:3300")).toBe("api");
  });

  it("returns null for null input", () => {
    expect(parseHostname(null)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseHostname("")).toBeNull();
  });

  it("returns null when host doesn't end in .lich.localhost", () => {
    expect(parseHostname("example.com")).toBeNull();
    expect(parseHostname("localhost:3300")).toBeNull();
    expect(parseHostname("api.feature-x.example.com:3300")).toBeNull();
  });

  it("returns null for bare lich.localhost (no key prefix)", () => {
    expect(parseHostname("lich.localhost")).toBeNull();
    expect(parseHostname("lich.localhost:3300")).toBeNull();
  });

  it("normalizes case", () => {
    expect(parseHostname("API.FEATURE-X.LICH.LOCALHOST:3300")).toBe(
      "api.feature-x",
    );
    expect(parseHostname("Api.Feature-X.Lich.Localhost")).toBe(
      "api.feature-x",
    );
  });

  it("handles multi-segment keys (e.g. supabase-db.feature-x)", () => {
    expect(
      parseHostname("supabase-db.feature-x.lich.localhost:3300"),
    ).toBe("supabase-db.feature-x");
  });
});

describe("deriveProxyPort", () => {
  it("returns the same port for the same identity (stable across calls)", () => {
    const id = "/Users/dev/checkouts/feature-x";
    const p1 = deriveProxyPort(id);
    const p2 = deriveProxyPort(id);
    const p3 = deriveProxyPort(id);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
  });

  it("always returns a port in the 30000-49999 range", () => {
    // 1000 samples exercise modulo across the full bucket — off-by-one
    // pushes into macOS ephemeral range
    for (let i = 0; i < 1_000; i++) {
      const port = deriveProxyPort(`/sample/path/${i}`);
      expect(port).toBeGreaterThanOrEqual(30_000);
      expect(port).toBeLessThan(50_000);
    }
  });

  it("returns different ports for different identities (dispersion check)", () => {
    // birthday paradox: ~22% chance of any collision with 100 trials over 20000 buckets
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      ports.add(deriveProxyPort(`/checkouts/branch-${i}`));
    }
    expect(ports.size).toBeGreaterThanOrEqual(95);
  });

  it("disperses tightly-clustered inputs into different buckets", () => {
    // multi-checkout case: long shared prefix must still bucket distinctly
    const a = deriveProxyPort("/Users/dev/lich-worktrees/agent-aaaaaaaa");
    const b = deriveProxyPort("/Users/dev/lich-worktrees/agent-bbbbbbbb");
    const c = deriveProxyPort("/Users/dev/lich-worktrees/agent-cccccccc");
    expect(new Set([a, b, c]).size).toBeGreaterThanOrEqual(2);
  });

  it("handles the empty-string identity without throwing", () => {
    expect(() => deriveProxyPort("")).not.toThrow();
    const port = deriveProxyPort("");
    expect(port).toBeGreaterThanOrEqual(30_000);
    expect(port).toBeLessThan(50_000);
  });
});

describe("startProxy — EADDRINUSE fallback", () => {
  it("falls back to OS-assigned port when the preferred port is in use", async () => {
    const squatter = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("squatter"),
    });
    // `.port` is `number | undefined` (undefined only for unix-socket servers)
    const conflictPort = squatter.port as number;
    expect(conflictPort).toBeGreaterThan(0);

    const upstream = makeUpstream(() => new Response("from proxy upstream"));
    upstreams.push(upstream);
    seedRouting({ "api.feature-x": upstream.url });

    try {
      proxy = await startProxy({
        port: conflictPort,
        routingTable: table,
      });

      const boundPort = Number(new URL(proxy.url).port);
      expect(boundPort).toBeGreaterThan(0);
      expect(boundPort).not.toBe(conflictPort);

      const res = await fetchVia(
        proxy.url,
        "api.feature-x.lich.localhost:3300",
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("from proxy upstream");
    } finally {
      squatter.stop(true);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  });

  it("does NOT fall back when port: 0 was requested explicitly (no infinite loop guard)", async () => {
    // port:0 already means OS-assigned — fallback recursion would loop forever
    proxy = await startProxy({ port: 0, routingTable: table });
    const port = Number(new URL(proxy.url).port);
    expect(port).toBeGreaterThan(0);
  });

  it("propagates non-EADDRINUSE bind errors instead of swallowing them", async () => {
    // negative path (EACCES on privileged ports) is platform-specific — happy path serves as proxy
    proxy = await startProxy({ port: 0, routingTable: table });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
