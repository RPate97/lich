import { readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { readRegistry } from './registry-reader';
import { buildStackViews } from './stacks';
import { LogTailer, resolveLogFile } from './log-tailer';
import { sampleStackMetrics } from './metrics';
import { runLichAction } from './actions';
import type { StacksResponse, LogEvent } from '../types';
import type { StackEntry } from './registry-reader';

export interface ServerConfig {
  /** Absolute path to ~/.lich/registry.json. */
  registryPath: string;
  /** Directory holding the built SPA (index.html + assets). */
  webDir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream';
}

/** GET /api/stacks — re-read the registry + derive views on every call. */
async function handleStacks(cfg: ServerConfig): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const stacks = await buildStackViews(reg);
  const body: StacksResponse = { stacks };
  return Response.json(body);
}

/**
 * GET /api/stacks/:key/metrics — sample CPU + memory for the stack on demand.
 * Returns 200 with a (possibly empty) StackMetrics JSON object; never throws.
 * Returns 404 if the stack key is not in the registry.
 */
async function handleMetrics(cfg: ServerConfig, key: string): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const entry = reg.stacks[key];
  if (!entry) return new Response('unknown stack', { status: 404 });
  const metrics = await sampleStackMetrics(entry.path, key, entry.containers);
  return Response.json(metrics);
}

/**
 * GET /api/stacks/:key/logs/:service — SSE stream of live log lines.
 * Resolves the service's log file from the registry entry's worktree path,
 * opens a LogTailer, and pushes each LogEvent as an SSE `message`. The tailer
 * is torn down when the client disconnects (the stream's `cancel`).
 */
async function handleLogStream(
  cfg: ServerConfig,
  key: string,
  service: string,
): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const entry = reg.stacks[key];
  if (!entry) return new Response('unknown stack', { status: 404 });
  const file = await resolveLogFile(entry.path, key, service);
  if (!file) return new Response('no log file for service', { status: 404 });

  let tailer: LogTailer | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      tailer = new LogTailer(file, (event) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Controller closed — client disconnected without a clean cancel().
          // Stop the tailer so the 300ms setInterval doesn't keep running
          // indefinitely for a client that is already gone.
          void tailer?.stop();
        }
      });
      await tailer.start();
    },
    async cancel() {
      await tailer?.stop();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/**
 * Enumerate the service names that have actual log files for a given stack.
 * Checks the raw `.log` dir and the `.jsonl` dir. Deduplicated.
 */
async function discoverLogServices(entry: StackEntry, key: string): Promise<string[]> {
  const seen = new Set<string>();

  // Raw .log dir: <worktreePath>/.lich/state/<key>/logs/
  const rawLogDir = join(entry.path, '.lich', 'state', key, 'logs');
  try {
    const files = await readdir(rawLogDir);
    for (const f of files) {
      if (f.endsWith('.log')) seen.add(f.slice(0, -4));
    }
  } catch {
    /* dir doesn't exist yet — fine */
  }

  // JSONL dir: <worktreePath>/.lich/logs/
  const jsonlDir = join(entry.path, '.lich', 'logs');
  try {
    const files = await readdir(jsonlDir);
    for (const f of files) {
      if (f.endsWith('.jsonl')) seen.add(f.slice(0, -6));
    }
  } catch {
    /* dir doesn't exist yet — fine */
  }

  return [...seen].sort();
}

/**
 * GET /api/stacks/:key/logs — SSE stream that merges every service's log file
 * into a single stream. Each emitted event carries a `service` field so the
 * client can filter by service client-side. One LogTailer is started per
 * discovered service; all tailers are torn down on client disconnect.
 */
async function handleMergedLogStream(
  cfg: ServerConfig,
  key: string,
): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const entry = reg.stacks[key];
  if (!entry) return new Response('unknown stack', { status: 404 });

  const services = await discoverLogServices(entry, key);

  const tailers: LogTailer[] = [];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const enqueue = (event: LogEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Controller closed — stop all tailers.
          for (const t of tailers) void t.stop();
        }
      };

      for (const service of services) {
        const file = await resolveLogFile(entry.path, key, service);
        if (!file) continue; // no file yet — skip (consistent with single-service endpoint)
        const tailer = new LogTailer(file, (e) => enqueue({ ...e, service }));
        tailers.push(tailer);
        await tailer.start();
      }
    },
    async cancel() {
      for (const t of tailers) await t.stop();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/**
 * POST /api/stacks/:key/restart — shell into `lich restart` for the
 * given stack's worktree. Returns 404 if the stack is not in the registry.
 * Always returns 200 with an ActionResult body — the `ok` field communicates
 * the CLI outcome; we intentionally don't 500 on a non-zero exit code so the
 * UI can show the stdout/stderr.
 */
async function handleRestart(cfg: ServerConfig, key: string): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const entry = reg.stacks[key];
  if (!entry) return new Response('unknown stack', { status: 404 });
  const result = await runLichAction(entry.path, 'restart');
  return Response.json(result);
}

/**
 * POST /api/stacks/:key/stop — shell into `lich down` for the given
 * stack's worktree. Returns 404 if the stack is not in the registry.
 */
async function handleStop(cfg: ServerConfig, key: string): Promise<Response> {
  const reg = await readRegistry(cfg.registryPath);
  const entry = reg.stacks[key];
  if (!entry) return new Response('unknown stack', { status: 404 });
  const result = await runLichAction(entry.path, 'down');
  return Response.json(result);
}

/** Serve a static file from webDir; returns 404 Response if missing. */
async function handleStatic(cfg: ServerConfig, pathname: string): Promise<Response> {
  // Default to index.html; strip the leading slash and block path traversal.
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(rel);
  if (safe.startsWith('..')) return new Response('forbidden', { status: 403 });
  const full = join(cfg.webDir, safe);
  try {
    const data = await readFile(full);
    return new Response(data, { headers: { 'content-type': contentType(full) } });
  } catch {
    // SPA fallback: unknown non-asset path → index.html (client-side routing).
    try {
      const html = await readFile(join(cfg.webDir, 'index.html'));
      return new Response(html, { headers: { 'content-type': CONTENT_TYPES['.html']! } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
}

/**
 * Route one request. Exported so the server test can exercise routing without
 * binding a socket if desired; `startDashboardServer` wires it into Bun.serve.
 */
export async function routeRequest(cfg: ServerConfig, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (pathname === '/api/stacks') return handleStacks(cfg);

  // Metrics: GET /api/stacks/:key/metrics
  const metricsMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/metrics$/);
  if (metricsMatch) {
    return handleMetrics(cfg, decodeURIComponent(metricsMatch[1]!));
  }

  // Restart: POST /api/stacks/:key/restart
  const restartMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/restart$/);
  if (restartMatch) {
    if (method !== 'POST') return new Response('method not allowed', { status: 405 });
    return handleRestart(cfg, decodeURIComponent(restartMatch[1]!));
  }

  // Stop: POST /api/stacks/:key/stop
  const stopMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/stop$/);
  if (stopMatch) {
    if (method !== 'POST') return new Response('method not allowed', { status: 405 });
    return handleStop(cfg, decodeURIComponent(stopMatch[1]!));
  }

  // Merged multi-service stream: GET /api/stacks/:key/logs
  const mergedLogMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/logs$/);
  if (mergedLogMatch) {
    return handleMergedLogStream(cfg, decodeURIComponent(mergedLogMatch[1]!));
  }

  // Single-service stream: GET /api/stacks/:key/logs/:service
  const logMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/logs\/([^/]+)$/);
  if (logMatch) {
    return handleLogStream(
      cfg,
      decodeURIComponent(logMatch[1]!),
      decodeURIComponent(logMatch[2]!),
    );
  }

  if (pathname.startsWith('/api/')) return new Response('not found', { status: 404 });

  return handleStatic(cfg, pathname);
}
