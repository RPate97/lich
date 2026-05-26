import { createHash } from "node:crypto";

import type { RoutingTable } from "./routing.js";
import { emptyStaticRoutes, type StaticRoutes } from "./static-routes.js";

export interface ProxyOpts {
  port: number;
  routingTable: RoutingTable;
  staticRoutes?: StaticRoutes;
  signal?: AbortSignal;
}

// 30000-49999: above common dev-server ports and macOS's typical
// outbound ephemeral range, minimizing collisions with stack-pinned ports.
const DERIVE_PROXY_PORT_LO = 30_000;
const DERIVE_PROXY_PORT_HI = 50_000;
const DERIVE_PROXY_PORT_SPAN = DERIVE_PROXY_PORT_HI - DERIVE_PROXY_PORT_LO;

/** Stable per-identity port in 30000-49999. SHA-256 for avalanche (nearby paths land in different buckets). */
export function deriveProxyPort(identity: string): number {
  const hash = createHash("sha256").update(identity).digest();
  const rawSpan = hash.readUInt16BE(0);
  return DERIVE_PROXY_PORT_LO + (rawSpan % DERIVE_PROXY_PORT_SPAN);
}

// Hop-by-hop headers per RFC 9110 § 7.6.1. Stripped from both proxied
// requests and responses. `host` included so upstream sees its own bound
// address rather than the friendly hostname.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** Strip `:port` and `.lich.localhost` suffix; returns null when the host doesn't match the schema. */
export function parseHostname(rawHost: string | null): string | null {
  if (!rawHost) return null;

  const hostOnly = rawHost.replace(/:\d+$/, "").toLowerCase();

  const suffix = ".lich.localhost";
  if (!hostOnly.endsWith(suffix)) return null;

  const key = hostOnly.slice(0, -suffix.length);
  if (key.length === 0) return null;

  return key;
}

function buildUpstreamRequest(req: Request, upstreamBase: string): Request {
  const incoming = new URL(req.url);
  const base = new URL(upstreamBase);
  // Preserve any subpath on the base URL (e.g. http://localhost:9000/api).
  const basePath = base.pathname.replace(/\/$/, "");
  const reqPath = incoming.pathname.startsWith("/")
    ? incoming.pathname
    : `/${incoming.pathname}`;
  const upstreamUrl = new URL(basePath + reqPath + incoming.search, base);

  const headers = new Headers();
  for (const [name, value] of req.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // GET/HEAD cannot carry a body per the Fetch spec.
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(upstreamUrl.toString(), {
    method,
    headers,
    body: hasBody ? req.body : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  } as RequestInit & { duplex: "half" | undefined });
}

function buildClientResponse(upstreamRes: Response): Response {
  const headers = new Headers();
  for (const [name, value] of upstreamRes.headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // Bun's fetch auto-decompresses gzip/deflate/brotli but keeps the
    // content-encoding header. Forwarding both makes the client double-
    // decompress and explode. Drop content-length too — decompressed
    // length differs from what the header claims.
    if (lower === "content-encoding" || lower === "content-length") continue;
    headers.set(name, value);
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}

function notFoundBody(
  proxyPort: number,
  knownHosts: string[],
  staticHosts: string[] = [],
): string {
  const lines = [
    `No friendly URL matches this Host header.`,
    ``,
    `The lich proxy routes requests of the form:`,
    `  http://<service>.<worktree>.lich.localhost:${proxyPort}/`,
    ``,
  ];
  if (staticHosts.length > 0) {
    lines.push(`Daemon-wide friendly hosts:`);
    for (const h of staticHosts.slice().sort()) {
      lines.push(`  http://${h}:${proxyPort}/`);
    }
    lines.push(``);
  }
  if (knownHosts.length > 0) {
    lines.push(`Known friendly hosts on this machine:`);
    for (const h of knownHosts.sort()) {
      lines.push(`  http://${h}.lich.localhost:${proxyPort}/`);
    }
  } else if (staticHosts.length === 0) {
    lines.push(`There are no friendly URLs registered right now.`);
    lines.push(`Run \`lich up\` in a worktree to register some.`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Start the reverse proxy. Binds 127.0.0.1 only — friendly URLs are a
 * local-dev convenience and binding 0.0.0.0 would expose every running
 * stack's ports to the network.
 */
export async function startProxy(opts: ProxyOpts): Promise<{
  url: string;
  stop(): Promise<void>;
}> {
  let actualPort = opts.port;

  const staticRoutes = opts.staticRoutes ?? emptyStaticRoutes();

  const handler = async (req: Request): Promise<Response> => {
    const rawHost = req.headers.get("host");

    // Static routes (e.g. apex `lich.localhost` → dashboard) consulted
    // first: the apex doesn't fit the subdomain grammar parseHostname expects.
    const staticUpstream = staticRoutes.lookup(rawHost);
    if (staticUpstream !== undefined) {
      try {
        const upstreamReq = buildUpstreamRequest(req, staticUpstream);
        const upstreamRes = await fetch(upstreamReq);
        return buildClientResponse(upstreamRes);
      } catch (err) {
        return new Response(
          `Upstream fetch failed for ${rawHost ?? "<no host>"} -> ${staticUpstream}\n${(err as Error).message}\n`,
          {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
    }

    const key = parseHostname(rawHost);

    if (key === null) {
      return new Response(
        notFoundBody(
          actualPort,
          knownHostsFromRouting(opts.routingTable),
          staticRoutes.hosts(),
        ),
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const upstream = opts.routingTable.get(key);
    if (upstream === undefined) {
      return new Response(
        notFoundBody(
          actualPort,
          knownHostsFromRouting(opts.routingTable),
          staticRoutes.hosts(),
        ),
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    let upstreamRes: Response;
    try {
      const upstreamReq = buildUpstreamRequest(req, upstream);
      upstreamRes = await fetch(upstreamReq);
    } catch (err) {
      return new Response(
        `Upstream fetch failed for ${key} -> ${upstream}\n${(err as Error).message}\n`,
        {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    return buildClientResponse(upstreamRes);
  };

  // Bind BOTH IPv4 (127.0.0.1) and IPv6 (::1) loopback. `hostname:
  // "localhost"` picks one family — on macOS that's ::1, and then
  // `curl http://127.0.0.1` fails with ECONNREFUSED. NOT 0.0.0.0:
  // that would accept off-host connections.
  //
  // Bind IPv4 first to lock in the port, then mirror on IPv6. On
  // EADDRINUSE for the preferred port, fall back to OS-assigned and
  // warn — covers two daemons resolving to the same derived port.
  let serverV4: ReturnType<typeof Bun.serve>;
  try {
    serverV4 = Bun.serve({
      port: opts.port,
      hostname: "127.0.0.1",
      fetch: handler,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE" || opts.port === 0) {
      throw err;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `proxy: preferred port ${opts.port} already in use; falling back to OS-assigned port (set runtime.proxy_port or LICH_PROXY_PORT to pin a specific port)`,
    );
    serverV4 = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: handler,
    });
  }
  actualPort = serverV4.port as number;

  let serverV6: ReturnType<typeof Bun.serve> | null = null;
  try {
    serverV6 = Bun.serve({
      port: actualPort,
      hostname: "::1",
      fetch: handler,
    });
  } catch (err) {
    // IPv6 disabled or some other bind failure on ::1. IPv4 already up — continue.
    // eslint-disable-next-line no-console
    console.warn(
      `proxy: IPv6 loopback bind on [::1]:${actualPort} failed (${(err as Error).message}); IPv4 only`,
    );
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    serverV4.stop(true);
    serverV6?.stop(true);
    // Yield so the OS releases the socket before any subsequent re-bind to the same port.
    await new Promise<void>((r) => setTimeout(r, 0));
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      await stop();
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          void stop();
        },
        { once: true },
      );
    }
  }

  return {
    // Explicit 127.0.0.1 URL avoids the `localhost`-resolution-order issue described at the bind site.
    url: `http://127.0.0.1:${actualPort}`,
    stop,
  };
}

// Structural cast to read the routing table's private entries map.
// The 404 body wants every known hostname; promoting a `keys()` API for
// only this use would force every consumer to deal with it.
function knownHostsFromRouting(table: RoutingTable): string[] {
  const internal = table as unknown as { entries: Map<string, string> };
  return Array.from(internal.entries.keys());
}
