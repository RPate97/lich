/**
 * Friendly-URL reverse proxy (LEV-413, Plan 5 Task 11).
 *
 * The lich daemon hosts this single HTTP proxy on `runtime.proxy_port`
 * (default 3300). Browsers and CLIs hit `http://api.feature-x.lich.localhost:3300/`
 * and this server:
 *
 *   1. Reads the `Host` header.
 *   2. Strips the `:port` suffix and the `.lich.localhost` trailing
 *      label, leaving the `<service>.<worktree>` key.
 *   3. Looks that up in the {@link RoutingTable} the daemon shared in.
 *   4. On hit, forwards the request to the upstream URL (preserving
 *      method, headers, body, path, query).
 *   5. On miss, returns 404 with a plain-text body explaining the
 *      friendly URL pattern.
 *
 * ## Localhost-only binding
 *
 * The proxy binds to `localhost` (effectively `127.0.0.1`) explicitly.
 * Friendly URLs are a local-dev convenience; exposing them on
 * `0.0.0.0` would let any host on the network proxy traffic through
 * this daemon to arbitrary local upstreams, which is at minimum a
 * footgun. The `hostname` option in `Bun.serve` is the way to enforce
 * this.
 *
 * ## Hostname matching schema
 *
 * Per spec: `<service>.<worktree>.lich.localhost(:port)?`.
 *
 *   - `api.main.lich.localhost:3300`            -> key `api.main`
 *   - `supabase-db.feature-x.lich.localhost`    -> key `supabase-db.feature-x`
 *   - `localhost:3300` (no subdomain)           -> miss, 404
 *   - `example.com`                             -> miss, 404
 *
 * The match is case-insensitive both because RFC 9110 says so and
 * because the routing table itself lowercases keys.
 *
 * ## WebSocket limitation (HTTP only for v1)
 *
 * The proxy does not handle WebSocket upgrades. A request with
 * `Upgrade: websocket` will be forwarded as a regular HTTP request and
 * the upstream's 426/400 response will pass through. The documented
 * escape hatch is `lich urls --raw`, which prints the underlying
 * `localhost:<port>` URLs that bypass the proxy entirely. See the
 * design spec section "Friendly URLs" for rationale.
 *
 * ## Hop-by-hop headers
 *
 * HTTP/1.1 defines "hop-by-hop" headers that apply only to a single
 * transport-level hop and must not be forwarded by intermediaries.
 * We strip them from both the request (before forwarding to upstream)
 * and the response (before returning to client) so the proxy behaves
 * like a well-behaved intermediary rather than tunnelling them through.
 * See RFC 9110 § 7.6.1.
 */

import type { RoutingTable } from "./routing.js";

export interface ProxyOpts {
  /**
   * TCP port to listen on. Pass `0` for an ephemeral port (read it
   * back via the returned `url`). Tests use `0` to avoid colliding
   * with real daemons; production uses `runtime.proxy_port`.
   */
  port: number;
  /**
   * The routing table the daemon owns. The proxy doesn't reload it
   * itself — that's the watcher's job. The proxy just calls `.get()`
   * on every request.
   */
  routingTable: RoutingTable;
  /**
   * Optional AbortSignal: when aborted, the server stops accepting
   * new connections. The returned `stop()` method does the same;
   * either path works. Tests prefer the signal pattern for clean
   * teardown.
   */
  signal?: AbortSignal;
}

/**
 * Hop-by-hop headers per RFC 9110 § 7.6.1 plus a few legacy ones we've
 * seen in the wild. These are stripped when we proxy a request or
 * response. `Host` is added by the upstream `fetch` call automatically
 * (it derives it from the URL), so we strip the incoming one to avoid
 * sending the friendly hostname to the upstream as well.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Not strictly hop-by-hop but we don't want to pass the friendly
  // hostname through — upstream sees its own bound address.
  "host",
]);

/**
 * Pull the key the routing table is indexed by out of an HTTP `Host`
 * header. Strips the `:port` suffix and the `.lich.localhost` trailing
 * label.
 *
 * Returns `null` if the host doesn't end in `.lich.localhost` — those
 * requests aren't for us (e.g. someone hitting `localhost:3300`
 * directly, or a stray request from a curious port scanner).
 *
 * Exported for unit testing; not part of the public proxy API.
 */
export function parseHostname(rawHost: string | null): string | null {
  if (!rawHost) return null;

  // Drop `:port` suffix. Note: `URL.parse` would do this for us but it
  // requires a scheme, and we don't want to fabricate one. A regex
  // matches the actual grammar: host = name `:` port?
  const hostOnly = rawHost.replace(/:\d+$/, "").toLowerCase();

  // Match `<key>.lich.localhost` exactly. Refuse bare `lich.localhost`
  // (no service/worktree subdomain) — that has no route to point at.
  const suffix = ".lich.localhost";
  if (!hostOnly.endsWith(suffix)) return null;

  const key = hostOnly.slice(0, -suffix.length);
  if (key.length === 0) return null;

  return key;
}

/**
 * Build the upstream Request given the incoming request and the
 * resolved upstream base URL.
 *
 * - Preserves path + query (the incoming request's pathname + search).
 * - Preserves method and body.
 * - Forwards headers except hop-by-hop ones (see HOP_BY_HOP_HEADERS).
 *
 * Returns a `Request` that can be passed straight to `fetch()`.
 */
function buildUpstreamRequest(req: Request, upstreamBase: string): Request {
  // Compose the upstream URL: `<upstream base origin><req path>`.
  // `req.url` is an absolute URL (Bun normalizes Host + path), so we
  // pull the pathname + search and append.
  const incoming = new URL(req.url);
  const base = new URL(upstreamBase);
  // Preserve any subpath the upstream base URL may have (e.g.
  // `http://localhost:9000/api`). We append the incoming pathname
  // onto whatever pathname the base already had — with a single slash
  // between them.
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

  // GET and HEAD must not carry a body per the Fetch spec; passing
  // one to `new Request` throws. Other methods may have one (POST,
  // PUT, PATCH, DELETE with body) — forward the original ReadableStream.
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(upstreamUrl.toString(), {
    method,
    headers,
    body: hasBody ? req.body : undefined,
    // Streaming uploads require this; Bun honors it.
    // @ts-expect-error — `duplex` is part of the Fetch standard but
    // not yet in lib.dom.d.ts. Bun supports it; Node 20+ supports it.
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });
}

/**
 * Build the Response we send back to the client given the upstream's
 * Response. Strips hop-by-hop headers from the upstream response and
 * preserves status, body, and the remaining headers.
 */
function buildClientResponse(upstreamRes: Response): Response {
  const headers = new Headers();
  for (const [name, value] of upstreamRes.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}

/**
 * 404 body for misses. Explains the friendly URL schema so a user who
 * hit the proxy with the wrong hostname (typo, no `lich up` for that
 * worktree, stale browser tab) gets enough context to fix it.
 */
function notFoundBody(proxyPort: number, knownHosts: string[]): string {
  const lines = [
    `No friendly URL matches this Host header.`,
    ``,
    `The lich proxy routes requests of the form:`,
    `  http://<service>.<worktree>.lich.localhost:${proxyPort}/`,
    ``,
  ];
  if (knownHosts.length > 0) {
    lines.push(`Known friendly hosts on this machine:`);
    for (const h of knownHosts.sort()) {
      lines.push(`  http://${h}.lich.localhost:${proxyPort}/`);
    }
  } else {
    lines.push(`There are no friendly URLs registered right now.`);
    lines.push(`Run \`lich up\` in a worktree to register some.`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Start the reverse proxy. Returns the bound URL (useful when `port: 0`)
 * and an idempotent `stop()` that drains in-flight requests before
 * resolving.
 *
 * The implementation is `Bun.serve({ fetch })` — Bun's HTTP server. We
 * pass `hostname: "localhost"` to bind 127.0.0.1 only (NOT 0.0.0.0;
 * see module docs). If `opts.signal` is provided, aborting it stops
 * the server too — convenient for tests using `AbortController`.
 */
export async function startProxy(opts: ProxyOpts): Promise<{
  url: string;
  stop(): Promise<void>;
}> {
  // Capture in a closure so we can reference it in the handler — Bun
  // sets `server.port` after listen, but the proxy port we use in the
  // 404 body should match the bound port (useful when port: 0).
  let actualPort = opts.port;

  const handler = async (req: Request): Promise<Response> => {
    const rawHost = req.headers.get("host");
    const key = parseHostname(rawHost);

    if (key === null) {
      // Pull every known host so the body is actually useful for
      // debugging. The routing table doesn't expose its keys directly;
      // we don't need that interface beyond this debugging case, so
      // we just include the request that arrived.
      return new Response(
        notFoundBody(actualPort, knownHostsFromRouting(opts.routingTable)),
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const upstream = opts.routingTable.get(key);
    if (upstream === undefined) {
      return new Response(
        notFoundBody(actualPort, knownHostsFromRouting(opts.routingTable)),
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
      // The upstream is unreachable — most common cause is the stack
      // is mid-restart or its port shifted. Return 502 (Bad Gateway)
      // with the underlying error so a debugging user can see what
      // happened.
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

  const server = Bun.serve({
    port: opts.port,
    hostname: "localhost",
    fetch: handler,
  });

  actualPort = server.port;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `true` = stop in flight requests as well (don't drain — tests
    // expect prompt teardown). Bun's `server.stop(force)` returns void
    // synchronously, but follow up with a microtask so the underlying
    // socket close finishes before the next test connects.
    server.stop(true);
    // Give the OS a tick to release the socket so a subsequent
    // `fetch` to the same port immediately observes connection-refused
    // rather than a stale connection. Empirically reliable.
    await new Promise<void>((r) => setTimeout(r, 0));
  };

  // Bridge the AbortSignal -> stop(). One-shot listener; aborting
  // after `stop()` already ran is a no-op via the `stopped` guard.
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
    url: `http://localhost:${actualPort}`,
    stop,
  };
}

/**
 * Pull the routing table's known hostname keys for the 404 body.
 * The `RoutingTable` doesn't expose keys via its public API (we don't
 * want a general "list every route" API for callers), but the proxy
 * is a trusted internal consumer. We use a structural cast to read
 * the private `entries` map. If this turns into a real API surface
 * (e.g. dashboard wants to list all routes) we'd promote it; for now
 * it's a debugging affordance only the proxy uses.
 */
function knownHostsFromRouting(table: RoutingTable): string[] {
  // The `entries` field is private in TS but accessible at runtime.
  // We do this explicitly so the 404 body can be informative without
  // forcing every RoutingTable consumer to deal with a `keys()` API
  // they don't otherwise need.
  const internal = table as unknown as { entries: Map<string, string> };
  return Array.from(internal.entries.keys());
}
