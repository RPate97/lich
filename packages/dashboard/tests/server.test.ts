// packages/dashboard/tests/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startDashboardServer, type DashboardHandle } from '../src/server';
import { routeRequest } from '../src/server/server';
import type { LogEvent } from '../src/types';

// Polyfill globalThis.Bun when running under Node/Vitest so that the
// startDashboardServer implementation (which uses Bun.serve) can work in tests.
// Bun.serve returns synchronously with a bound port; we approximate that here
// by allocating a free port synchronously (via a subprocess) then binding to it.
if (!(globalThis as unknown as { Bun?: unknown }).Bun) {
  (globalThis as unknown as { Bun: unknown }).Bun = {
    serve(opts: {
      port: number;
      hostname: string;
      fetch(req: Request): Promise<Response> | Response;
    }): { port: number; stop(): void } {
      // Obtain a free ephemeral port synchronously. Bun.serve binds the
      // socket before returning, so we need the port number available
      // immediately without waiting for an async listen event.
      const freePort = Number(
        execFileSync(process.execPath, [
          '-e',
          'const net=require("net");const s=net.createServer();' +
            's.listen(0,"127.0.0.1");' +
            's.once("listening",()=>{process.stdout.write(String(s.address().port));s.close();});',
        ], { encoding: 'utf8' }).trim(),
      );

      const server = http.createServer(async (nodeReq, nodeRes) => {
        const url = `http://${nodeReq.headers.host ?? '127.0.0.1'}${nodeReq.url ?? '/'}`;
        const req = new Request(url, {
          method: nodeReq.method ?? 'GET',
          headers: nodeReq.headers as HeadersInit,
        });
        const res = await opts.fetch(req);
        nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
        const buf = await res.arrayBuffer();
        nodeRes.end(Buffer.from(buf));
      });
      // Bind to the pre-allocated free port (tiny TOCTOU window is acceptable
      // in a local test environment).
      server.listen(freePort, opts.hostname);
      return {
        port: freePort,
        stop() {
          server.close();
        },
      };
    },
  };
}

let handle: DashboardHandle | undefined;
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

describe('dashboard server', () => {
  it('serves GET /api/stacks from the registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srv-'));
    const wt = join(dir, 'wt');
    await mkdir(join(wt, '.levelzero', 'state', 'abc', 'pids'), { recursive: true });
    await writeFile(
      join(wt, '.levelzero', 'state', 'abc', 'pids', 'api.pid'),
      `${process.pid}\n`,
    );
    const registryPath = join(dir, 'registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        stacks: {
          abc: {
            path: wt, branch: 'main', ports: {}, urls: {},
            containers: [], network: 'n', logDir: '.levelzero/logs',
            createdAt: '2026-05-21T00:00:00.000Z',
          },
        },
      }),
    );

    handle = await startDashboardServer({ registryPath, webDir: dir, port: 0 });
    const res = await fetch(`${handle.url}/api/stacks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stacks: Array<{ key: string; status: string }> };
    expect(body.stacks).toHaveLength(1);
    expect(body.stacks[0]!.key).toBe('abc');
    expect(body.stacks[0]!.status).toBe('running');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 404 for an unknown api route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srv-'));
    const registryPath = join(dir, 'registry.json');
    await writeFile(registryPath, JSON.stringify({ stacks: {} }));
    handle = await startDashboardServer({ registryPath, webDir: dir, port: 0 });
    const res = await fetch(`${handle.url}/api/nonsense`);
    expect(res.status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Merged log stream tests ──────────────────────────────────────────────────

/**
 * Read SSE events from a ReadableStream until we have collected at least
 * `count` events, then cancel the stream. Returns the parsed LogEvent array.
 * Times out after `timeoutMs`.
 */
async function collectSSEEvents(
  body: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 3000,
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out collecting ${count} SSE events`)), timeoutMs),
  );

  try {
    await Promise.race([
      (async () => {
        while (events.length < count) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are delimited by double-newline.
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              events.push(JSON.parse(dataLine.slice(6)) as LogEvent);
            } catch {
              /* skip malformed */
            }
          }
        }
      })(),
      deadline,
    ]);
  } finally {
    await reader.cancel();
  }
  return events;
}

describe('merged log stream endpoint', () => {
  it('returns 404 for an unknown stack key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merged-'));
    const registryPath = join(dir, 'registry.json');
    await writeFile(registryPath, JSON.stringify({ stacks: {} }));
    const cfg = { registryPath, webDir: dir };
    const res = await routeRequest(cfg, new Request('http://h/api/stacks/nope/logs'));
    expect(res.status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });

  it('streams events from every service and tags each with its service name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merged-'));
    const wt = join(dir, 'wt');
    const logsDir = join(wt, '.levelzero', 'state', 'mystack', 'logs');
    await mkdir(logsDir, { recursive: true });

    // Write two service log files.
    await writeFile(join(logsDir, 'api.log'), 'api line one\napi line two\n');
    await writeFile(join(logsDir, 'worker.log'), 'worker line one\n');

    const registryPath = join(dir, 'registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        stacks: {
          mystack: {
            path: wt,
            branch: 'main',
            ports: {},
            urls: {},
            containers: [],
            network: 'n',
            logDir: '.levelzero/logs',
            createdAt: '2026-05-22T00:00:00.000Z',
          },
        },
      }),
    );

    const cfg = { registryPath, webDir: dir };
    const res = await routeRequest(cfg, new Request('http://h/api/stacks/mystack/logs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.body).toBeTruthy();

    // Collect 3 events (2 from api + 1 from worker).
    const events = await collectSSEEvents(res.body!, 3);

    expect(events.length).toBeGreaterThanOrEqual(3);

    const apiEvents = events.filter((e) => e.service === 'api');
    const workerEvents = events.filter((e) => e.service === 'worker');

    expect(apiEvents.length).toBe(2);
    expect(apiEvents.map((e) => e.line)).toEqual(['api line one', 'api line two']);

    expect(workerEvents.length).toBe(1);
    expect(workerEvents[0]!.line).toBe('worker line one');

    await rm(dir, { recursive: true, force: true });
  });

  it('reads from .jsonl when no .log file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merged-'));
    const wt = join(dir, 'wt');
    const jsonlDir = join(wt, '.levelzero', 'logs');
    await mkdir(jsonlDir, { recursive: true });

    await writeFile(
      join(jsonlDir, 'svc.jsonl'),
      JSON.stringify({ ts: '2026-05-22T00:00:00Z', level: 'info', stream: 'stdout', message: 'hello from svc' }) + '\n',
    );

    const registryPath = join(dir, 'registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        stacks: {
          s2: {
            path: wt,
            branch: 'main',
            ports: {},
            urls: {},
            containers: [],
            network: 'n',
            logDir: '.levelzero/logs',
            createdAt: '2026-05-22T00:00:00.000Z',
          },
        },
      }),
    );

    const cfg = { registryPath, webDir: dir };
    const res = await routeRequest(cfg, new Request('http://h/api/stacks/s2/logs'));
    expect(res.status).toBe(200);

    const events = await collectSSEEvents(res.body!, 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.service).toBe('svc');
    expect(events[0]!.line).toBe('hello from svc');
    expect(events[0]!.level).toBe('info');

    await rm(dir, { recursive: true, force: true });
  });

  it('single-service endpoint still works and returns 404 for missing service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merged-'));
    const registryPath = join(dir, 'registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        stacks: {
          abc: {
            path: dir,
            branch: 'main',
            ports: {},
            urls: {},
            containers: [],
            network: 'n',
            logDir: '.levelzero/logs',
            createdAt: '2026-05-22T00:00:00.000Z',
          },
        },
      }),
    );
    const cfg = { registryPath, webDir: dir };
    const res = await routeRequest(cfg, new Request('http://h/api/stacks/abc/logs/nosvc'));
    expect(res.status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });
});
