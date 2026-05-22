// packages/dashboard/tests/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startDashboardServer, type DashboardHandle } from '../src/server';

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
