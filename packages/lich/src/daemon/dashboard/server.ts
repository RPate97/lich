/**
 * Dashboard HTTP server (LEV-408, Plan 5 Task 6).
 *
 * The lich daemon hosts this `Bun.serve` HTTP server on an ephemeral
 * port (production: `port: 0` so the OS picks; tests: same). The bound
 * URL is recorded in `<LICH_HOME>/daemon.url` by the daemon's main loop
 * (Task 12) and printed by `lich up`'s summary block so the user can
 * click through to the dashboard.
 *
 * ## Responsibilities
 *
 *   1. REST endpoints (`/healthz`, `/api/stacks`, `/api/stacks/:id`,
 *      `/api/stacks/:id/services/:service`) consumed by the SPA.
 *   2. Static file serving from an optional `uiDir` with SPA fallback
 *      to `index.html` for any non-API path. When no `uiDir` is
 *      configured (Plan 5 Task 13 hasn't landed yet), the root path
 *      returns a placeholder HTML so an unbuilt deployment doesn't
 *      look broken.
 *   3. An in-memory cache of the {@link StackView} list, refreshed
 *      explicitly by the daemon's watcher via `refresh()`. The cache
 *      keeps response latency under a millisecond regardless of how
 *      many stacks the machine is running.
 *
 * ## Why an explicit cache + watcher-driven refresh (not per-request reads)
 *
 * A naive implementation reads every `state.json` on every request.
 * That's fine at our scale (≤ tens of stacks) but it generates a flood
 * of `fs.readdir`/`fs.readFile` calls every 2s × every open dashboard
 * tab — a noisy spike for nothing. The cache flips the model: the
 * watcher tells us when the disk state changed, we read once and serve
 * the cached view to every concurrent request. Atomic swap (build new
 * view in a local, assign once at the end) guarantees no fetch ever
 * sees a half-built view, even if it lands mid-rebuild.
 *
 * ## Localhost-only binding
 *
 * Bound to `localhost` (127.0.0.1) only. The dashboard is a local-dev
 * convenience; binding `0.0.0.0` would expose every running stack's
 * config and ports to anyone on the network. Same reasoning as the
 * proxy (see `daemon/proxy/proxy.ts` module JSDoc).
 *
 * ## Path traversal protection
 *
 * Static file serving resolves each requested path against `uiDir` via
 * `path.resolve` and checks that the result stays within the `uiDir`
 * boundary. Requests like `/../etc/passwd` after URL-decoding are
 * rejected with 404 (matching the SPA fallback's "file not found"
 * behavior so an attacker can't even confirm the guard exists by
 * differentiating 400 vs 404 responses). The fallback to `index.html`
 * only triggers for paths that DO stay within `uiDir` but don't match
 * any file.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { loadStacksView, type StackView } from "./stacks-view.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DashboardServerOpts {
  /**
   * TCP port to listen on. Pass `0` for an ephemeral port (read it back
   * from the returned `url`). The daemon uses `0` so it never collides
   * with whatever the user might be running on a specific port.
   */
  port?: number;
  /**
   * Filesystem root the dashboard reads `state.json` files from. In
   * production this is `<LICH_HOME>/stacks`. Tests pass a fresh tmpdir.
   */
  stateRoot: string;
  /**
   * Optional directory containing the compiled SPA assets. When set,
   * the server serves files from this directory and falls back to
   * `index.html` for any path that doesn't match a file. When unset,
   * the root path returns a placeholder HTML (Plan 5 Task 13 lands
   * the real SPA).
   */
  uiDir?: string;
  /**
   * Optional AbortSignal. When aborted, the server stops accepting new
   * connections. Mirrors `startProxy`'s pattern in `daemon/proxy/proxy.ts`.
   */
  signal?: AbortSignal;
}

/**
 * Handle returned by {@link startDashboardServer}. Exposed surface:
 *
 *   - `url` — the bound URL (use this in the daemon's `daemon.url` file
 *     and in `lich up`'s summary block)
 *   - `refresh()` — invalidate the in-memory cache. The daemon wires
 *     this to the watcher's `onChange` callback.
 *   - `stop()` — idempotent shutdown.
 */
export interface DashboardServer {
  url: string;
  refresh(): void;
  stop(): Promise<void>;
}

/**
 * Boot the dashboard server. Returns once `Bun.serve` is bound AND the
 * initial cache has been populated — callers can immediately fetch
 * `/api/stacks` without racing the first reload.
 */
export async function startDashboardServer(
  opts: DashboardServerOpts,
): Promise<DashboardServer> {
  // ----- 1. Build the cache machinery ------------------------------------
  //
  // `cache` is the live array `/api/stacks` returns. Each `refresh()`
  // call kicks off an async load that, when complete, atomically swaps
  // a new array into this slot. We never mutate the existing array —
  // mid-flight readers always see a fully-formed array (the old one or
  // the new one).
  let cache: StackView[] = [];

  // Track an in-flight reload so concurrent refresh() calls don't fan
  // out to N parallel disk scans. The watcher debounces upstream, but
  // a frantic UI hitting refresh manually shouldn't be able to hammer
  // the filesystem either.
  let inflight: Promise<void> | null = null;

  const reload = async (): Promise<void> => {
    // If a reload is already in flight, piggyback on it — the next
    // result will include the current on-disk state. This is the
    // standard "deduplicate concurrent calls" pattern; no caller sees
    // a stale read because the reload always reads fresh state.json
    // contents at the moment IT runs.
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const next = await loadStacksView(opts.stateRoot);
        // Atomic swap. Subsequent reads see the full new array; no
        // intermediate state is ever observable.
        cache = next;
      } catch (err) {
        // Log but don't throw — the cache stays at its previous value,
        // which is preferable to crashing the daemon on a transient
        // filesystem hiccup. The watcher will trigger another reload
        // on the next state change.
        // eslint-disable-next-line no-console
        console.warn(
          `[lich daemon] dashboard: cache reload failed: ${(err as Error).message}`,
        );
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  // Populate the cache before we bind the port — callers expect a
  // GET /api/stacks immediately after the promise resolves to return
  // the current on-disk state, not an empty array waiting for the
  // first refresh tick.
  await reload();

  // ----- 2. Resolve uiDir (path traversal guard) -------------------------
  //
  // We resolve uiDir once and compare each request's resolved path
  // against the boundary. Pre-resolving avoids per-request work and
  // pins the boundary to whatever existed at start time.
  const resolvedUiDir = opts.uiDir ? resolve(opts.uiDir) : null;

  // ----- 3. Build the request handler ------------------------------------
  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const path = u.pathname;

    // -- Health probe --
    if (path === "/healthz") {
      return jsonResponse({ ok: true });
    }

    // -- API surface --
    if (path === "/api/stacks") {
      return jsonResponse(cache);
    }

    // /api/stacks/:id and /api/stacks/:id/services/:service. We avoid a
    // full router library — three routes, straightforward string match.
    if (path.startsWith("/api/stacks/")) {
      const rest = path.slice("/api/stacks/".length);
      // Split into at most 3 segments: [id, "services", serviceName].
      // Trailing empty segment from a trailing slash is filtered out.
      const segments = rest.split("/").filter((s) => s.length > 0);

      if (segments.length === 1) {
        // /api/stacks/:id
        const stack = cache.find((s) => s.id === segments[0]);
        if (!stack) {
          return notFound(`stack not found: ${segments[0]}`);
        }
        return jsonResponse(stack);
      }

      if (segments.length === 3 && segments[1] === "services") {
        // /api/stacks/:id/services/:service
        const stack = cache.find((s) => s.id === segments[0]);
        if (!stack) {
          return notFound(`stack not found: ${segments[0]}`);
        }
        const service = stack.services.find((sv) => sv.name === segments[2]);
        if (!service) {
          return notFound(`service not found: ${segments[2]}`);
        }
        return jsonResponse(service);
      }

      // Unknown /api/stacks/... shape. Don't fall through to the SPA
      // — that would 200 a /api/... request which is misleading.
      return notFound(`unknown API path: ${path}`);
    }

    // -- Other /api/* paths --
    // Any other /api/... route is unknown. Refuse to serve the SPA
    // shell for these; an unknown API call should look like an unknown
    // API call, not a successful page load.
    if (path.startsWith("/api/")) {
      return notFound(`unknown API path: ${path}`);
    }

    // -- Static / SPA --
    if (resolvedUiDir !== null) {
      const file = await serveStatic(resolvedUiDir, path);
      if (file) return file;
      // Fall back to index.html so React Router can take over.
      const indexFile = await serveStatic(resolvedUiDir, "/index.html");
      if (indexFile) return indexFile;
      // No index.html either — surprising configuration; respond 404
      // so an operator notices the missing file.
      return notFound("ui index.html not found");
    }

    // -- No uiDir: placeholder page --
    // The dashboard server is up, the API works, but the SPA bundle
    // hasn't been built yet (Plan 5 Task 13 lands it). Tell the user
    // explicitly so an unbuilt build doesn't look like a server bug.
    return new Response(PLACEHOLDER_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  // ----- 4. Bind the server ----------------------------------------------
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "localhost",
    fetch: handler,
  });

  const url = `http://localhost:${server.port}`;

  // ----- 5. Stop() — idempotent shutdown ---------------------------------
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `true` forces in-flight requests to drop. Tests expect prompt
    // teardown — the watcher should have already debounced any
    // refreshes by the time we shut down.
    server.stop(true);
    // Wait for the OS socket to release. Without this, a test that
    // immediately re-binds the same port sees EADDRINUSE.
    await new Promise<void>((r) => setTimeout(r, 0));
  };

  // ----- 6. Bridge AbortSignal -> stop() ---------------------------------
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

  // ----- 7. Return the handle --------------------------------------------
  return {
    url,
    // refresh() is fire-and-forget from the caller's perspective. The
    // daemon's watcher calls this whenever any state.json under the
    // root changes; we kick off an async reload and return immediately.
    // Tests that need to observe the post-reload state poll the API
    // (see `waitFor` in server.test.ts).
    refresh: () => {
      void reload();
    },
    stop,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON response with the standard headers. Centralized so the
 * content-type and the JSON encoding match across every endpoint.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Build a 404 with a JSON body. Including `message` makes the API more
 * debuggable for CLI tools without changing the status code semantics.
 */
function notFound(message: string): Response {
  return jsonResponse({ error: "not_found", message }, 404);
}

/**
 * Resolve a requested URL path against `uiDir` and return a Response
 * with the file's contents if it's a regular file inside `uiDir`.
 * Returns null on miss (file doesn't exist, is a directory, or resolves
 * outside `uiDir`).
 *
 * Path traversal protection: we resolve the joined path and verify it
 * stays under `uiDir`. A request for `/../etc/passwd` resolves above
 * `uiDir` and is rejected (returns null → caller decides whether to
 * fall back to index.html, which is fine because index.html is INSIDE
 * uiDir).
 */
async function serveStatic(
  uiDir: string,
  urlPath: string,
): Promise<Response | null> {
  // Map "/" to "/index.html" so a bare root request gets the SPA shell.
  // For any other path, strip the leading slash and join against uiDir.
  const relative = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");

  // URL-decode the path so encoded traversal attempts (`%2e%2e/`) don't
  // sneak past the resolve check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    // Malformed percent-encoding — treat as miss.
    return null;
  }

  const candidate = resolve(uiDir, decoded);

  // Boundary check: candidate must be uiDir itself or live inside it.
  // We append `sep` to the boundary so `<uiDir>foo` (which startsWith
  // `<uiDir>`) doesn't slip through as if it were inside.
  if (!candidate.startsWith(uiDir + sep) && candidate !== uiDir) {
    return null;
  }

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  let contents: Buffer;
  try {
    contents = await readFile(candidate);
  } catch {
    return null;
  }

  return new Response(contents, {
    status: 200,
    headers: { "content-type": contentTypeFor(candidate) },
  });
}

/**
 * Minimal content-type sniffer keyed off the file extension. The set
 * covers what a Vite-built SPA bundle ships: HTML, JS, CSS, plus the
 * common font/image formats. Everything else falls back to
 * `application/octet-stream` — accurate but unhelpful, but the SPA
 * bundle shouldn't have any of those.
 */
function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * HTML body served at `/` when `uiDir` is not configured. Plan 5 Task 13
 * lands the real SPA; until then this placeholder makes the unbuilt
 * deployment self-explanatory rather than a blank page.
 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>lich dashboard</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      margin: 0;
      padding: 2rem;
      background: #0d0d0f;
      color: #e8e8ea;
      min-height: 100vh;
      box-sizing: border-box;
    }
    h1 { font-weight: 600; margin-bottom: 0.5rem; }
    p { line-height: 1.5; color: #b3b3b8; }
    code {
      background: #1a1a1c;
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
      font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
      font-size: 0.95em;
    }
    .endpoints { margin-top: 2rem; }
    .endpoints li { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <h1>lich dashboard</h1>
  <p>
    The dashboard UI not built yet — Plan 5 Task 13 will add it.
    The REST API is live and you can poke it directly:
  </p>
  <ul class="endpoints">
    <li><code>GET /healthz</code> — health probe</li>
    <li><code>GET /api/stacks</code> — list every running stack</li>
    <li><code>GET /api/stacks/:id</code> — single-stack detail</li>
    <li><code>GET /api/stacks/:id/services/:service</code> — single-service detail</li>
  </ul>
</body>
</html>
`;
