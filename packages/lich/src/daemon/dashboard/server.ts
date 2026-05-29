import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { LogTail } from "../../logs/tail.js";
import { runLichAction, type ActionResult } from "./actions.js";
import { loadStacksView, type StackView } from "./stacks-view.js";
import type { StackSnapshot } from "../../state/snapshot.js";
import type { RoutingTable } from "../proxy/routing.js";

/** Minimal contract for the SSE handler — start/onLine/stop. Real LogTail satisfies this structurally; tests inject fakes. */
export interface LogTailLike {
  start(): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  stop(): Promise<void>;
}

/** Constructor for tail instances. Default factory builds a real LogTail; tests inject fakes. */
export type TailFactory = (opts: { logPath: string }) => LogTailLike;

/** In-memory SPA asset source, e.g. the generated embedded-ui manifest. Lets the daemon binary ship without a sidecar dist dir. */
export interface EmbeddedAssetSource {
  /** Asset path is relative to the SPA root with no leading slash (e.g. "index.html", "assets/index-abc.js"). */
  get(
    path: string,
  ): { bytes: Uint8Array; contentType: string } | undefined;
}

export interface DashboardServerOpts {
  /** Pass `0` for an ephemeral port (read it back from `url`). */
  port?: number;
  /** Root the dashboard reads `state.json` files from; production = `<LICH_HOME>/stacks`. */
  stateRoot: string;
  /** Reverse-proxy port surfaced in each StackView for friendly URL construction. Defaults to 3300. */
  proxyPort?: number;
  /** Directory of compiled SPA assets. Wins over `embeddedUi` so devs can override via `LICH_UI_DIR`. */
  uiDir?: string;
  /** In-memory SPA assets (the embedded manifest). Used only when `uiDir` is unset. */
  embeddedUi?: EmbeddedAssetSource;
  /** When aborted, the server stops accepting new connections. */
  signal?: AbortSignal;
  /** Factory for log tails. Defaults to real LogTail; tests inject fakes. */
  tailFactory?: TailFactory;
  /** Action runner. Defaults to {@link runLichAction}; tests inject fakes to avoid a compiled binary. */
  runAction?: (
    worktreePath: string,
    action: "down" | "restart",
  ) => Promise<ActionResult>;
  /**
   * Proxy's routing table, shared from the daemon. Enables `/api/routing`
   * GET (snapshot) and POST /api/routing/reload (force re-scan, bypassing
   * the watcher debounce). When unset the endpoints return 503.
   */
  routingTable?: RoutingTableHandle;
}

/** Slice of {@link RoutingTable} the dashboard needs. Structurally compatible with the real table; tests inject minimal fakes. */
export interface RoutingTableHandle {
  /** Hostname-sorted snapshot; matches {@link RoutingTable.list}. */
  list(): Array<{ hostname: string; upstream_url: string }>;
  /** Force a re-scan, bypassing the watcher debounce. Matches {@link RoutingTable.reload}. */
  reload(): Promise<void>;
}

export interface DashboardServer {
  url: string;
  /** Invalidate the in-memory cache; daemon wires this to the watcher's onChange. */
  refresh(): void;
  /** Idempotent shutdown. */
  stop(): Promise<void>;
}

/** Boot the dashboard server; resolves once Bun.serve is bound AND the initial cache is populated. */
export async function startDashboardServer(
  opts: DashboardServerOpts,
): Promise<DashboardServer> {
  // cache is the live array /api/stacks returns; atomic swap on each
  // reload means mid-flight readers always see a fully-formed array.
  let cache: StackView[] = [];

  // Dedupe concurrent reloads so a manually-spammed UI can't fan out to
  // N parallel disk scans.
  let inflight: Promise<void> | null = null;

  const reload = async (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const next = await loadStacksView(
          opts.stateRoot,
          opts.proxyPort ?? 3300,
        );
        cache = next;
      } catch (err) {
        // Keep the previous cache rather than crashing on a transient FS
        // hiccup; the watcher triggers another reload on the next change.
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

  // Populate before binding the port — callers expect an immediate
  // GET /api/stacks to reflect on-disk state.
  await reload();

  // Resolve once; per-request paths are compared against this boundary.
  const resolvedUiDir = opts.uiDir ? resolve(opts.uiDir) : null;

  const tailFactory: TailFactory =
    opts.tailFactory ?? ((o) => new LogTail({ logPath: o.logPath }));

  const runAction = opts.runAction ?? runLichAction;

  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const path = u.pathname;

    if (path === "/healthz") {
      return jsonResponse({ ok: true });
    }

    if (path === "/api/stacks") {
      return jsonResponse(cache);
    }

    // GET /api/routing snapshots the table; POST /api/routing/reload
    // forces a re-scan bypassing the watcher debounce. Both return 503
    // when no routingTable was passed (unit-test only).
    if (path === "/api/routing") {
      if (req.method !== "GET") {
        return methodNotAllowed("GET");
      }
      if (!opts.routingTable) {
        return new Response(
          JSON.stringify({
            error: "routing table not configured on this daemon",
          }),
          {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      return jsonResponse(opts.routingTable.list());
    }

    if (path === "/api/routing/reload") {
      if (req.method !== "POST") {
        return methodNotAllowed("POST");
      }
      if (!opts.routingTable) {
        return new Response(
          JSON.stringify({
            error: "routing table not configured on this daemon",
          }),
          {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      // Awaited so the 204 response means the table reflects the latest
      // on-disk state — `lich up` relies on this contract.
      try {
        await opts.routingTable.reload();
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: `routing reload failed: ${(err as Error).message}`,
          }),
          {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      return new Response(null, { status: 204 });
    }

    if (path.startsWith("/api/stacks/")) {
      const rest = path.slice("/api/stacks/".length);
      const segments = rest.split("/").filter((s) => s.length > 0);

      // Handle action endpoints before the GET-by-id branch so a POST
      // /stop doesn't fall through to "unknown API path".
      if (
        segments.length === 2 &&
        (segments[1] === "stop" || segments[1] === "restart")
      ) {
        if (req.method !== "POST") {
          return methodNotAllowed("POST");
        }
        const action = segments[1] === "stop" ? "down" : "restart";
        return handleActionRequest(
          opts.stateRoot,
          segments[0],
          action,
          runAction,
        );
      }

      if (segments.length === 1) {
        const stack = cache.find((s) => s.id === segments[0]);
        if (!stack) {
          return notFound(`stack not found: ${segments[0]}`);
        }
        return jsonResponse(stack);
      }

      if (segments.length === 2 && segments[1] === "logs") {
        const stackId = segments[0];
        const stack = cache.find((s) => s.id === stackId);
        if (!stack) {
          return notFound(`stack not found: ${stackId}`);
        }
        const serviceName = u.searchParams.get("service");
        if (serviceName !== null) {
          const service = stack.services.find((sv) => sv.name === serviceName);
          if (!service) {
            return notFound(`service not found: ${serviceName}`);
          }
          return sseResponse(
            buildSingleServiceStream({
              stateRoot: opts.stateRoot,
              stackId,
              service: serviceName,
              tailFactory,
              clientSignal: req.signal,
            }),
          );
        }
        return sseResponse(
          buildMergedStream({
            stateRoot: opts.stateRoot,
            stackId,
            services: stack.services.map((s) => s.name),
            tailFactory,
            clientSignal: req.signal,
          }),
        );
      }

      if (segments.length === 3 && segments[1] === "services") {
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

      // Don't fall through to the SPA — 200 on an unknown /api/* is misleading.
      return notFound(`unknown API path: ${path}`);
    }

    if (path.startsWith("/api/")) {
      return notFound(`unknown API path: ${path}`);
    }

    if (resolvedUiDir !== null) {
      const file = await serveStatic(resolvedUiDir, path);
      if (file) return file;
      // Fall back to index.html so React Router can take over.
      const indexFile = await serveStatic(resolvedUiDir, "/index.html");
      if (indexFile) return indexFile;
      return notFound("ui index.html not found");
    }

    if (opts.embeddedUi) {
      const hit = serveEmbedded(opts.embeddedUi, path);
      if (hit) return hit;
      const indexHit = serveEmbedded(opts.embeddedUi, "/index.html");
      if (indexHit) return indexHit;
      // No index.html in the embed — fall through to placeholder.
    }

    return new Response(PLACEHOLDER_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  // Bind IPv4 + IPv6 loopback separately: `hostname: "localhost"` picks
  // one family (macOS picks ::1), then `curl http://127.0.0.1` fails
  // with ECONNREFUSED. IPv4 first to lock in the port; IPv6 is best-effort.
  const serverV4 = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });

  let serverV6: ReturnType<typeof Bun.serve> | null = null;
  try {
    serverV6 = Bun.serve({
      port: serverV4.port,
      hostname: "::1",
      fetch: handler,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `dashboard: IPv6 loopback bind on [::1]:${serverV4.port} failed (${(err as Error).message}); IPv4 only`,
    );
  }

  const url = `http://127.0.0.1:${serverV4.port}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    serverV4.stop(true);
    serverV6?.stop(true);
    // Yield so the OS releases the socket before any immediate re-bind.
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
    url,
    refresh: () => {
      void reload();
    },
    stop,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(message: string): Response {
  return jsonResponse({ error: "not_found", message }, 404);
}

/** Wrap a stream as an SSE Response. Pins content-type, no-cache, keep-alive — getting any of these wrong silently breaks clients. */
function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function encodeSseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

// Initial SSE comment frame to force header flush — without an initial
// byte Bun delays headers until the first body chunk, so `await fetch()`
// against an idle log stream hangs. Leading `:` makes this a comment per
// the SSE spec, ignored by EventSource.
const SSE_HEARTBEAT = new TextEncoder().encode(": ok\n\n");

function logPathFor(
  stateRoot: string,
  stackId: string,
  serviceName: string,
): string {
  return join(stateRoot, stackId, "logs", `${serviceName}.log`);
}

interface BuildStreamOpts {
  stateRoot: string;
  stackId: string;
  tailFactory: TailFactory;
  /** Bun fires this on client disconnect; mirrored into stream cancel for tail teardown. */
  clientSignal?: AbortSignal;
}

function buildSingleServiceStream(
  opts: BuildStreamOpts & { service: string },
): ReadableStream<Uint8Array> {
  // Function-scope so `cancel` can reach the tail to stop it.
  let tail: LogTailLike | null = null;
  let closed = false;

  const closeOnce = (controller: ReadableStreamDefaultController<Uint8Array> | null): void => {
    if (closed) return;
    closed = true;
    if (tail) {
      void tail.stop();
    }
    if (controller) {
      try {
        controller.close();
      } catch {
        // already closed via cancel — harmless
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_HEARTBEAT);

      tail = opts.tailFactory({
        logPath: logPathFor(opts.stateRoot, opts.stackId, opts.service),
      });

      // Wire onLine BEFORE start() so we don't miss a line emitted
      // synchronously on the first poll tick.
      tail.onLine((line) => {
        if (closed) return;
        try {
          controller.enqueue(
            encodeSseFrame({ service: opts.service, line }),
          );
        } catch {
          closeOnce(controller);
        }
      });

      void tail.start();

      if (opts.clientSignal) {
        if (opts.clientSignal.aborted) {
          closeOnce(controller);
        } else {
          opts.clientSignal.addEventListener(
            "abort",
            () => closeOnce(controller),
            { once: true },
          );
        }
      }
    },
    cancel() {
      // Consumer abandoned the stream — stop the tail so we don't leak
      // a poll loop per closed dashboard tab.
      closeOnce(null);
    },
  });
}

/** Merged SSE stream — one LogTail per service, each event labeled with the source service name. */
function buildMergedStream(
  opts: BuildStreamOpts & { services: string[] },
): ReadableStream<Uint8Array> {
  const tails: LogTailLike[] = [];
  let closed = false;

  const closeAll = (controller: ReadableStreamDefaultController<Uint8Array> | null): void => {
    if (closed) return;
    closed = true;
    for (const tail of tails) {
      void tail.stop();
    }
    if (controller) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_HEARTBEAT);

      for (const service of opts.services) {
        const tail = opts.tailFactory({
          logPath: logPathFor(opts.stateRoot, opts.stackId, service),
        });
        tails.push(tail);

        tail.onLine((line) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSseFrame({ service, line }));
          } catch {
            closeAll(controller);
          }
        });
        void tail.start();
      }

      if (opts.clientSignal) {
        if (opts.clientSignal.aborted) {
          closeAll(controller);
        } else {
          opts.clientSignal.addEventListener(
            "abort",
            () => closeAll(controller),
            { once: true },
          );
        }
      }
    },
    cancel() {
      closeAll(null);
    },
  });
}

function methodNotAllowed(allowed: string): Response {
  return new Response(
    JSON.stringify({ error: "method_not_allowed", allowed }),
    {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: allowed,
      },
    },
  );
}

/** 500 reserved for "couldn't even try to run the action"; subprocess failures come back as 200 with `ok: false`. */
function internalServerError(message: string): Response {
  return jsonResponse({ error: "internal_server_error", message }, 500);
}

/** Read worktree_path from state.json directly (not via cache — the StackView projection omits it). */
async function readWorktreePath(
  stateRoot: string,
  stackId: string,
): Promise<string | null> {
  const file = join(stateRoot, stackId, "state.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  let snap: StackSnapshot;
  try {
    snap = JSON.parse(raw) as StackSnapshot;
  } catch {
    return null;
  }
  if (typeof snap.worktree_path !== "string" || snap.worktree_path.length === 0) {
    return null;
  }
  return snap.worktree_path;
}

/** 404 unknown stack; 500 on runAction throw (missing binary); 200 with `ok: false` for subprocess failures so the dashboard renders detail. */
async function handleActionRequest(
  stateRoot: string,
  stackId: string,
  action: "down" | "restart",
  runAction: (
    worktreePath: string,
    action: "down" | "restart",
  ) => Promise<ActionResult>,
): Promise<Response> {
  const worktreePath = await readWorktreePath(stateRoot, stackId);
  if (worktreePath === null) {
    return notFound(`stack not found: ${stackId}`);
  }
  try {
    const result = await runAction(worktreePath, action);
    return jsonResponse(result);
  } catch (err) {
    return internalServerError(
      `failed to run lich action: ${(err as Error).message}`,
    );
  }
}

/** Serve a file under `uiDir`. Returns null on miss or path-traversal attempt. */
async function serveStatic(
  uiDir: string,
  urlPath: string,
): Promise<Response | null> {
  const relative = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");

  // URL-decode so encoded traversal (`%2e%2e/`) can't sneak past the
  // resolve check below.
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }

  const candidate = resolve(uiDir, decoded);

  // Append `sep` so `<uiDir>foo` (which startsWith `<uiDir>`) doesn't
  // slip through as if it were inside.
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

/** In-memory counterpart to {@link serveStatic}. No traversal check — the source is a flat map, no filesystem reachable. */
function serveEmbedded(
  source: EmbeddedAssetSource,
  urlPath: string,
): Response | null {
  const relative =
    urlPath === "/" || urlPath === ""
      ? "index.html"
      : urlPath.replace(/^\/+/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const asset = source.get(decoded);
  if (!asset) return null;
  return new Response(asset.bytes, {
    status: 200,
    headers: { "content-type": asset.contentType },
  });
}

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

/** Placeholder served at `/` when neither uiDir nor embeddedUi is configured. */
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
    The dashboard UI not built yet. The REST API is live and you can poke it directly:
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
