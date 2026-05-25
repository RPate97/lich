/**
 * Dashboard HTTP server (LEV-408 + LEV-409, Plan 5 Tasks 6 + 7).
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
 *   2. Server-Sent Events log-tail endpoints (LEV-409):
 *      - `GET /api/stacks/:id/logs?service=<name>` — single-service stream
 *      - `GET /api/stacks/:id/logs` — merged stream across all services
 *      Each frame is `data: {"service":<name>,"line":<line>}\n\n`.
 *      Backed by the `LogTail` primitive (`logs/tail.ts`); one tail per
 *      service per open connection. Disconnects (ReadableStream cancel
 *      or req.signal abort) stop every tail attached to the stream so
 *      we don't leak poll loops on closed browser tabs.
 *   3. Static file serving from an optional `uiDir` with SPA fallback
 *      to `index.html` for any non-API path. When no `uiDir` is
 *      configured (Plan 5 Task 13 hasn't landed yet), the root path
 *      returns a placeholder HTML so an unbuilt deployment doesn't
 *      look broken.
 *   4. An in-memory cache of the {@link StackView} list, refreshed
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
import { LogTail } from "../../logs/tail.js";
import { runLichAction, type ActionResult } from "./actions.js";
import { loadStacksView, type StackView } from "./stacks-view.js";
import type { StackSnapshot } from "../../state/snapshot.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Minimal contract a {@link DashboardServerOpts.tailFactory} must
 * satisfy. The real {@link LogTail} from `logs/tail.ts` implements this
 * structurally; the seam exists so unit tests can swap in a fake that
 * emits lines on demand AND lets the test observe `.stop()` to verify
 * the SSE handler's cleanup path on client disconnect.
 *
 * We deliberately type only the methods the SSE handler calls — start,
 * onLine, stop — rather than re-exporting LogTail's full surface. A
 * tighter interface means a test fake can be a few lines of code.
 */
export interface LogTailLike {
  start(): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  stop(): Promise<void>;
}

/**
 * Constructor signature for tail instances. The default factory
 * instantiates the real {@link LogTail} from `logs/tail.ts`; tests pass
 * a custom factory that returns a fake observable.
 */
export type TailFactory = (opts: { logPath: string }) => LogTailLike;

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
  /**
   * Optional factory for constructing log tails. Defaults to instantiating
   * the real {@link LogTail} from `logs/tail.ts`. Tests inject a fake so
   * they can observe stop() calls and emit lines on demand without poking
   * at real files.
   */
  tailFactory?: TailFactory;
  /**
   * Injection hook for the action runner (LEV-418 / Plan 5 Task 16).
   * Defaults to the real {@link runLichAction} which spawns the `lich`
   * binary in the stack's worktree. Tests pass a fake to assert spawn
   * shape without needing a compiled binary on disk.
   *
   * The handler awaits this for both `/stop` and `/restart`; the only
   * difference between the two POST routes is the `action` argument
   * passed in. Keeping the dependency injected at the server-construction
   * boundary (rather than per-request) avoids per-call overhead and lets
   * the test harness control the runner's lifecycle if needed.
   */
  runAction?: (
    worktreePath: string,
    action: "down" | "restart",
  ) => Promise<ActionResult>;
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

  // Default tail factory: real `LogTail` from `logs/tail.ts`. Tests
  // override via `opts.tailFactory` to inject a fake that records stop()
  // calls and emits lines on demand. See LogTailLike for the contract.
  const tailFactory: TailFactory =
    opts.tailFactory ?? ((o) => new LogTail({ logPath: o.logPath }));

  // ----- 2a. Resolve the action runner (LEV-418) -------------------------
  // Default to the real CLI-shellout runner. Tests inject a fake so they
  // can assert spawn args without needing a compiled binary on disk.
  const runAction = opts.runAction ?? runLichAction;

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

    // /api/stacks/:id, /api/stacks/:id/services/:service,
    // POST /api/stacks/:id/stop, POST /api/stacks/:id/restart.
    // We avoid a full router library — straightforward string match.
    if (path.startsWith("/api/stacks/")) {
      const rest = path.slice("/api/stacks/".length);
      // Split into segments: [id], [id, "services", serviceName],
      // [id, "logs"], [id, "stop"], or [id, "restart"]. Trailing empty
      // segment from a trailing slash is filtered out.
      const segments = rest.split("/").filter((s) => s.length > 0);

      // -- Action endpoints (POST /api/stacks/:id/{stop,restart}) --
      // Handled before the GET-by-id case so a request like
      // `POST /api/stacks/<id>/stop` doesn't accidentally fall through
      // to the "unknown API path" branch.
      if (
        segments.length === 2 &&
        (segments[1] === "stop" || segments[1] === "restart")
      ) {
        if (req.method !== "POST") {
          // Wrong-method on an action endpoint is a 405. Some
          // clients (curl with no -X) default to GET and would get
          // a confusing "stack not found" if we returned 404 here.
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
        // /api/stacks/:id
        const stack = cache.find((s) => s.id === segments[0]);
        if (!stack) {
          return notFound(`stack not found: ${segments[0]}`);
        }
        return jsonResponse(stack);
      }

      if (segments.length === 2 && segments[1] === "logs") {
        // /api/stacks/:id/logs[?service=<name>]
        const stackId = segments[0];
        const stack = cache.find((s) => s.id === stackId);
        if (!stack) {
          return notFound(`stack not found: ${stackId}`);
        }
        const serviceName = u.searchParams.get("service");
        if (serviceName !== null) {
          // Single-service stream. 404 if the named service isn't in
          // the stack so the client gets immediate feedback rather
          // than an empty event stream.
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
        // Merged stream — one LogTail per service in the stack, each
        // event labeled with the source service.
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
  // LEV-459: bind BOTH IPv4 (127.0.0.1) and IPv6 (::1) loopback. Same
  // rationale as the proxy server: `hostname: "localhost"` binds whichever
  // family the OS prefers (macOS chooses ::1), then `curl http://127.0.0.1`
  // gets ECONNREFUSED. We bind IPv4 first to lock in the port, then mirror
  // it on IPv6. IPv6 is best-effort — if `::1` fails (host has IPv6
  // disabled), log + continue with IPv4 only.
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

  // ----- 5. Stop() — idempotent shutdown ---------------------------------
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `true` forces in-flight requests to drop. Both servers stopped
    // together.
    serverV4.stop(true);
    serverV6?.stop(true);
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
 * Wrap a {@link ReadableStream} in an SSE-shaped {@link Response} with
 * the headers EventSource clients expect. Centralized so every SSE
 * endpoint pins the same content-type, cache-control, and connection
 * directives. Without `Cache-Control: no-cache` an aggressive proxy
 * might buffer the entire stream; without `Connection: keep-alive`
 * an HTTP/1.1 client might close after a single chunk.
 *
 * status defaults to 200 — SSE never uses other codes once the stream
 * is opened (errors are surfaced inside event payloads, not via HTTP).
 */
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

/**
 * Encode one SSE frame from a JSON-serializable payload. The shape is
 * verbatim what an EventSource client receives in its `onmessage`
 * handler's `event.data`. We keep encoding centralized so every event
 * frame uses the same `data:` prefix and `\n\n` terminator — getting
 * either wrong silently breaks the client without any obvious error.
 */
function encodeSseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * SSE comment frame enqueued at stream start so the HTTP runtime flushes
 * the response headers immediately. Without an initial byte, Bun (and
 * other servers) delay sending the headers until the first body chunk —
 * which means a client that does `await fetch(url)` against an idle log
 * stream hangs until the first log line lands. The leading `:` makes
 * this a comment per the SSE spec (HTML5 § "Server-sent events"); both
 * EventSource and our test frame parser ignore it.
 *
 * Pre-encoded as a module-level constant because every SSE response
 * sends exactly this byte sequence as its first chunk.
 */
const SSE_HEARTBEAT = new TextEncoder().encode(": ok\n\n");

/**
 * Per-service log file path. Mirrors `state/directory.ts`'s
 * `serviceLogPath` but works against an explicit `stateRoot` (the
 * `directory.ts` helper reads `LICH_HOME` globally; the dashboard
 * server takes its root as an option for test isolation).
 */
function logPathFor(
  stateRoot: string,
  stackId: string,
  serviceName: string,
): string {
  return join(stateRoot, stackId, "logs", `${serviceName}.log`);
}

/**
 * Build a single-service SSE stream. Spins up one {@link LogTail},
 * subscribes to its `onLine` callback, enqueues an SSE frame for each
 * complete line, and tears the tail down when the client disconnects
 * (the ReadableStream's `cancel` fires, OR the request's AbortSignal
 * fires — both wire to the same cleanup path).
 *
 * The frame payload shape is `{ service, line }` (no timestamp — the
 * underlying LogTail only emits text lines, and we don't want to
 * fabricate timestamps that don't appear in the source). Future tasks
 * can extend the shape; the SPA's EventSource handler is forward-
 * compatible because it just consumes the JSON.
 */
interface BuildStreamOpts {
  stateRoot: string;
  stackId: string;
  tailFactory: TailFactory;
  /**
   * The fetch request's AbortSignal. Bun fires this when the client
   * disconnects. We mirror it into the stream's cancel handler so a
   * disconnect triggers tail teardown even if the request is aborted
   * without going through the ReadableStream cancel path (defensive —
   * different runtimes can route disconnects differently).
   */
  clientSignal?: AbortSignal;
}

function buildSingleServiceStream(
  opts: BuildStreamOpts & { service: string },
): ReadableStream<Uint8Array> {
  // Tail and close-state live at function scope so both `start` and
  // `cancel` can reach them. Without this, `cancel` (which fires on
  // client disconnect) has no way to reach the tail it needs to stop.
  let tail: LogTailLike | null = null;
  let closed = false;

  const closeOnce = (controller: ReadableStreamDefaultController<Uint8Array> | null): void => {
    if (closed) return;
    closed = true;
    if (tail) {
      // Fire-and-forget; stop() is async and idempotent.
      void tail.stop();
    }
    if (controller) {
      try {
        controller.close();
      } catch {
        // controller may already be closed (cancel path) — harmless.
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Push an initial SSE comment frame so the server flushes HTTP
      // headers immediately. Without this, Bun (and most HTTP runtimes)
      // wait for the first body byte before sending headers — which
      // means a client `await fetch()` hangs until the first log line
      // arrives. The `:` prefix makes this a comment per the SSE spec,
      // so EventSource and our test parser both ignore it.
      controller.enqueue(SSE_HEARTBEAT);

      tail = opts.tailFactory({
        logPath: logPathFor(opts.stateRoot, opts.stackId, opts.service),
      });

      // Wire line callback BEFORE start() so we don't miss a line the
      // poll loop might emit synchronously on its first tick.
      tail.onLine((line) => {
        if (closed) return;
        try {
          controller.enqueue(
            encodeSseFrame({ service: opts.service, line }),
          );
        } catch {
          // Controller closed mid-callback — stop the tail and bail.
          closeOnce(controller);
        }
      });

      // Kick the poll loop. We don't await — start() resolves once the
      // interval is scheduled; lines arrive on subsequent ticks.
      void tail.start();

      // Honor the request's AbortSignal. Bun's `req.signal` fires when
      // the client drops the connection; we want to release the tail
      // immediately rather than waiting for the next poll's stop-check.
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
      // ReadableStream.cancel runs when the consumer abandons the
      // stream (typically: the browser tab closed or the fetch
      // response was discarded). Stop the tail to release the poll
      // loop's setInterval — otherwise we leak a file watcher per
      // closed dashboard tab. Pass null for the controller because
      // we're being notified the stream is already torn down on the
      // consumer side; just release upstream resources.
      closeOnce(null);
    },
  });
}

/**
 * Build a merged SSE stream — one {@link LogTail} per service, each
 * event labeled with the source service name so the client can
 * distinguish lines from different services. Cleanup stops every
 * tail on client disconnect.
 *
 * If the stack has no services, the stream stays open but never
 * emits — same shape as a no-traffic single-service stream. The
 * client closing the connection is still cleaned up properly.
 */
function buildMergedStream(
  opts: BuildStreamOpts & { services: string[] },
): ReadableStream<Uint8Array> {
  // Tails and close-state at function scope so `cancel` can reach the
  // tails to stop them — see buildSingleServiceStream for the same
  // pattern + rationale.
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
      // Heartbeat to flush HTTP headers immediately — see
      // buildSingleServiceStream for the rationale.
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

/**
 * Build a 405 Method Not Allowed with the standard `Allow` header. Used
 * by the action endpoints to reject GET/etc. on POST-only routes.
 */
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

/**
 * Build a 500 with a JSON body. Reserved for "the server couldn't even
 * try to run the action" — e.g. the lich binary is missing. The action's
 * own subprocess failures get returned as 200 with `ok: false` so the
 * dashboard renders them as a result-panel error rather than a generic
 * HTTP error page.
 */
function internalServerError(message: string): Response {
  return jsonResponse({ error: "internal_server_error", message }, 500);
}

/**
 * Look up a stack's `worktree_path` by reading its on-disk snapshot.
 *
 * Returns the path on success, or `null` when the stack id is unknown
 * (state.json missing) or the snapshot is malformed.
 *
 * Reads from `stateRoot/<id>/state.json` directly — we deliberately do
 * NOT route through the in-memory `cache`, which is the projection layer
 * (`StackView`) that omits `worktree_path` as an implementation detail.
 * The action endpoint needs the raw worktree path to spawn the CLI in
 * the right cwd; that's the source of truth on disk.
 */
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
    // Other read errors (EACCES, EIO): treat as unknown — the dashboard
    // shouldn't differentiate. The error gets surfaced by the parent's
    // 404 message which is sufficient for an operator debugging.
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

/**
 * Shared handler for POST /api/stacks/:id/{stop,restart}.
 *
 * Sequence:
 *   1. Look up the stack's `worktree_path` from its on-disk snapshot.
 *      → 404 when the stack is unknown.
 *   2. Run the action via the injected `runAction` (default: spawn the
 *      `lich` binary in that worktree).
 *      → 500 when the action throws (e.g. lich binary missing — a hard
 *        configuration error).
 *      → 200 with the {@link ActionResult} JSON in all other cases,
 *        INCLUDING `ok: false`. The dashboard wants to render the
 *        outcome regardless of whether the CLI succeeded; an HTTP error
 *        would hide useful detail.
 *
 * The shape mirrors v0's `packages/dashboard/src/server/actions.ts`
 * handler — same field names, same status-code semantics.
 */
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
    // Hard configuration error — e.g. lich binary missing. The action
    // didn't even start. 500 because the dashboard's request can't be
    // fulfilled at all (vs the action ran-and-failed case, which is a
    // 200 with ok: false).
    return internalServerError(
      `failed to run lich action: ${(err as Error).message}`,
    );
  }
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
