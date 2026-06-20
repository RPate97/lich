import { execFile as execFileCb } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { LogTail } from "../../logs/tail.js";
import { runLichAction, type ActionResult } from "./actions.js";
import { loadStacksView, type StackView } from "./stacks-view.js";
import type { StackSnapshot } from "../../state/snapshot.js";
import type { RoutingTable } from "../proxy/routing.js";
import type { MetricsSampler } from "../metrics/sampler.js";
import type { StackMetricsSnapshot } from "../metrics/types.js";
import { parsePsOutput } from "../metrics/ps.js";
import { pickDataProvider, type DataProviderDeps } from "../../stack/data-provider.js";

const execFile = promisify(execFileCb);

/** Read state.json for a stack from a custom stateRoot (not global stackDir). Returns null on ENOENT or parse failure. */
async function readSnapshotLocal(stateRoot: string, stackId: string): Promise<StackSnapshot | null> {
  const file = join(stateRoot, stackId, "state.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  try {
    return JSON.parse(raw) as StackSnapshot;
  } catch {
    return null;
  }
}

/** Minimal contract for the SSE handler — start/onLine/stop. Real LogTail satisfies this structurally; tests inject fakes. */
export interface LogTailLike {
  start(): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  stop(): Promise<void>;
}

/** Constructor for tail instances. Default factory builds a real LogTail; tests inject fakes. */
export type TailFactory = (opts: { logPath: string; startOffset?: number }) => LogTailLike;

const TAIL_LINES = 200;

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
  /** Bind hostname. Defaults to "127.0.0.1". Pass "0.0.0.0" to accept non-loopback connections (e.g. in-VM daemon). */
  hostname?: string;
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
  /**
   * Metrics sampler shared from the daemon. Enables `/api/stacks/:id/metrics`
   * (snapshot) and `/api/stacks/:id/metrics/stream` (SSE). When unset both
   * endpoints return 503.
   */
  metricsSampler?: MetricsSamplerHandle;
  /**
   * Indirection for `ps -A ...` so tests can stub the process snapshot.
   * Defaults to the system `ps`. Powers `/api/stacks/:id/services/:svc/proc-tree`.
   */
  psProbe?: () => Promise<string>;
}

/** Slice of {@link MetricsSampler} the dashboard needs. Structurally compatible; tests inject minimal fakes. */
export interface MetricsSamplerHandle {
  latest(stackId: string): StackMetricsSnapshot | null;
  subscribe(
    stackId: string,
    cb: (snap: StackMetricsSnapshot) => void,
  ): () => void;
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
    opts.tailFactory ?? ((o) => new LogTail({ logPath: o.logPath, startOffset: o.startOffset ?? 0 }));

  const runAction = opts.runAction ?? runLichAction;

  const psProbe: () => Promise<string> =
    opts.psProbe ??
    (async () => {
      const { stdout } = await execFile(
        "ps",
        ["-A", "-o", "pid,ppid,rss,pcpu,time"],
        { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    });

  const buildDeps = (): DataProviderDeps => ({
    stateRoot: opts.stateRoot,
    proxyPort: opts.proxyPort ?? 3300,
    tailFactory,
    metricsSampler: opts.metricsSampler,
    psFn: async () => parsePsOutput(await psProbe()),
  });

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

      // /metrics + /metrics/stream — handled before GET-by-id so the
      // /:id route doesn't 404 on the trailing segment.
      if (
        (segments.length === 2 && segments[1] === "metrics") ||
        (segments.length === 3 &&
          segments[1] === "metrics" &&
          segments[2] === "stream")
      ) {
        if (req.method !== "GET") {
          return methodNotAllowed("GET");
        }
        const stackId = segments[0];
        const stackSnap = await readSnapshotLocal(opts.stateRoot, stackId);
        if (!stackSnap) {
          return notFound(`stack not found: ${stackId}`);
        }
        // Local stacks require a sampler; http (sandbox) stacks fetch from the VM daemon.
        if (!opts.metricsSampler && stackSnap.data_source?.kind !== "http") {
          return new Response(
            JSON.stringify({
              error: "metrics sampler not configured on this daemon",
            }),
            {
              status: 503,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          );
        }
        const provider = pickDataProvider(stackSnap, buildDeps());
        if (segments.length === 3) {
          return sseResponse(provider.metricsStream(stackId, req.signal));
        }
        const metricsSnap = await provider.metricsLatest(stackId);
        if (metricsSnap === null) {
          // Sample hasn't fired yet — return an empty-but-shaped payload so
          // clients don't have to special-case the warmup window.
          return jsonResponse({
            stack_id: stackId,
            sampled_at: new Date().toISOString(),
            total: { cpu_pct: 0, mem_bytes: 0 },
            services: [],
          });
        }
        return jsonResponse(metricsSnap);
      }

      if (segments.length === 1) {
        const stackId = segments[0];
        const snap = await readSnapshotLocal(opts.stateRoot, stackId);
        if (!snap) {
          return notFound(`stack not found: ${stackId}`);
        }
        const provider = pickDataProvider(snap, buildDeps());
        const stack = await provider.loadStack(stackId);
        if (!stack) {
          return notFound(`stack not found: ${stackId}`);
        }
        return jsonResponse(stack);
      }

      if (segments.length === 2 && segments[1] === "logs") {
        const stackId = segments[0];
        const serviceName = u.searchParams.get("service");
        if (serviceName !== null) {
          const snap = await readSnapshotLocal(opts.stateRoot, stackId);
          if (!snap) {
            return notFound(`stack not found: ${stackId}`);
          }
          if (!snap.services.find((s) => s.name === serviceName)) {
            return notFound(`service not found: ${serviceName}`);
          }
          const provider = pickDataProvider(snap, buildDeps());
          return sseResponse(provider.tailLogs(stackId, serviceName, req.signal));
        }
        const mergedSnap = await readSnapshotLocal(opts.stateRoot, stackId);
        if (!mergedSnap) return notFound(`stack not found: ${stackId}`);
        const mergedProvider = pickDataProvider(mergedSnap, buildDeps());
        return sseResponse(mergedProvider.tailAllLogs(stackId, req.signal));
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

      // /services/:name/proc-tree — owned-only; walks the local ps subtree
      // rooted at the recorded parent PID. 409 on compose services because
      // there's no host PID to root the walk at.
      if (
        segments.length === 4 &&
        segments[1] === "services" &&
        segments[3] === "proc-tree"
      ) {
        if (req.method !== "GET") {
          return methodNotAllowed("GET");
        }
        const procStackId = segments[0];
        const procSvcName = segments[2];
        const procSnap = await readSnapshotLocal(opts.stateRoot, procStackId);
        if (!procSnap) {
          return notFound(`stack not found: ${procStackId}`);
        }
        const procSvc = procSnap.services.find((s) => s.name === procSvcName);
        if (!procSvc) {
          return notFound(`service not found: ${procSvcName}`);
        }
        if (procSvc.kind !== "owned") {
          return new Response(
            JSON.stringify({
              error: "compose_service_has_no_process_tree",
              message: `service ${procSvc.name} is a compose service; use 'docker stats' for its container metrics`,
            }),
            {
              status: 409,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        const procProvider = pickDataProvider(procSnap, buildDeps());
        let procResult: Awaited<ReturnType<typeof procProvider.procTree>>;
        try {
          procResult = await procProvider.procTree(procStackId, procSvcName);
        } catch (err) {
          return internalServerError(`ps probe failed: ${(err as Error).message}`);
        }
        if (procResult === null) {
          return notFound(`service not running: ${procSvcName}`);
        }
        return jsonResponse(procResult);
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

  const bindHost = opts.hostname ?? "127.0.0.1";

  // Bind IPv4 + IPv6 loopback separately: `hostname: "localhost"` picks
  // one family (macOS picks ::1), then `curl http://127.0.0.1` fails
  // with ECONNREFUSED. IPv4 first to lock in the port; IPv6 is best-effort.
  // When a custom hostname is set (e.g. 0.0.0.0), skip the IPv6 bind — the
  // caller controls the bind surface.
  const serverV4 = Bun.serve({
    port: opts.port ?? 0,
    hostname: bindHost,
    fetch: handler,
  });

  let serverV6: ReturnType<typeof Bun.serve> | null = null;
  if (opts.hostname === undefined) {
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
  }

  const url = `http://${bindHost}:${serverV4.port}`;

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

/** Return the byte offset at which to start tailing so at most `tailLines` lines are replayed. */
export async function computeTailOffset(logPath: string, tailLines: number): Promise<number> {
  let fileSize: number;
  try {
    const st = await stat(logPath);
    fileSize = st.size;
  } catch {
    return 0;
  }
  if (fileSize === 0) return 0;

  // Read a chunk from the end large enough to contain tailLines lines.
  // Average ~200 bytes/line × tailLines × 2 safety factor, capped at fileSize.
  const chunkSize = Math.min(fileSize, tailLines * 400);
  const readFrom = fileSize - chunkSize;

  const buf = Buffer.allocUnsafe(chunkSize);
  let handle;
  try {
    handle = await open(logPath, "r");
  } catch {
    return 0;
  }
  let bytesRead = 0;
  try {
    const r = await handle.read(buf, 0, chunkSize, readFrom);
    bytesRead = r.bytesRead;
  } catch {
    return 0;
  } finally {
    try { await handle.close(); } catch { /* ignore */ }
  }

  if (bytesRead <= 0) return 0;

  const chunk = buf.slice(0, bytesRead).toString("utf8");
  let newlineCount = 0;
  let pos = chunk.length - 1;
  // Skip a trailing newline so we don't count an empty final "line".
  if (chunk[pos] === "\n") pos--;
  while (pos >= 0 && newlineCount < tailLines) {
    if (chunk[pos] === "\n") newlineCount++;
    pos--;
  }
  // pos is now just before the first character of the (tailLines+1)th-from-end line.
  return readFrom + pos + 1;
}

export interface BuildStreamOpts {
  stateRoot: string;
  stackId: string;
  tailFactory: TailFactory;
  /** Bun fires this on client disconnect; mirrored into stream cancel for tail teardown. */
  clientSignal?: AbortSignal;
}

export function buildSingleServiceStream(
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
    async start(controller) {
      controller.enqueue(SSE_HEARTBEAT);

      const logPath = logPathFor(opts.stateRoot, opts.stackId, opts.service);
      const startOffset = await computeTailOffset(logPath, TAIL_LINES);

      tail = opts.tailFactory({ logPath, startOffset });

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
export function buildMergedStream(
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
    async start(controller) {
      controller.enqueue(SSE_HEARTBEAT);

      // Compute per-service offsets independently so a chatty service log
      // doesn't starve quieter ones in the merged stream.
      const logPaths = opts.services.map((s) =>
        logPathFor(opts.stateRoot, opts.stackId, s),
      );
      const offsets = await Promise.all(
        logPaths.map((p) => computeTailOffset(p, TAIL_LINES)),
      );

      for (let i = 0; i < opts.services.length; i++) {
        const service = opts.services[i];
        const tail = opts.tailFactory({ logPath: logPaths[i], startOffset: offsets[i] });
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

export interface MetricsStreamOpts {
  sampler: MetricsSamplerHandle;
  stackId: string;
  clientSignal?: AbortSignal;
}

/** SSE stream of per-sample metrics snapshots. Sends the current latest immediately so consumers paint without waiting one tick. */
export function buildMetricsStream(
  opts: MetricsStreamOpts,
): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const close = (controller: ReadableStreamDefaultController<Uint8Array> | null): void => {
    if (closed) return;
    closed = true;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
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

      const latest = opts.sampler.latest(opts.stackId);
      if (latest !== null) {
        try {
          controller.enqueue(encodeSseFrame(latest));
        } catch {
          close(controller);
          return;
        }
      }

      unsubscribe = opts.sampler.subscribe(opts.stackId, (snap) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseFrame(snap));
        } catch {
          close(controller);
        }
      });

      if (opts.clientSignal) {
        if (opts.clientSignal.aborted) {
          close(controller);
        } else {
          opts.clientSignal.addEventListener(
            "abort",
            () => close(controller),
            { once: true },
          );
        }
      }
    },
    cancel() {
      close(null);
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
