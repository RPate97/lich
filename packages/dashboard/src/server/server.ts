import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { readRegistry } from './registry-reader';
import { buildStackViews } from './stacks';
import { LogTailer, resolveLogFile } from './log-tailer';
import type { StacksResponse } from '../types';

export interface ServerConfig {
  /** Absolute path to ~/.levelzero/registry.json. */
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
          /* controller closed — client gone */
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

  if (pathname === '/api/stacks') return handleStacks(cfg);

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
