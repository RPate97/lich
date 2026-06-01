import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  type DashboardServer,
} from "../../../../src/daemon/dashboard/server.js";

let stateRoot: string;
let server: DashboardServer | null = null;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-proc-tree-endpoint-"));
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

interface WriteOpts {
  pid?: number;
  kind?: "owned" | "compose";
  serviceName?: string;
}

function writeState(stackId: string, opts: WriteOpts = {}): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: "/tmp/wt",
      status: "up",
      started_at: "2026-05-30T00:00:00.000Z",
      services: [
        {
          name: opts.serviceName ?? "api",
          kind: opts.kind ?? "owned",
          state: "ready",
          ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        },
      ],
    }),
    "utf8",
  );
}

const PS_OUTPUT = [
  "  PID  PPID    RSS  %CPU      TIME",
  " 1001     1  10240   5.2   0:01.50",
  " 1002  1001   2048   1.0   0:00.40",
  " 1003  1001   1024   0.4   0:00.20",
  " 1004  1003    512   0.1   0:00.05",
  " 9999     1   5120   0.0   0:00.10",
].join("\n");

describe("dashboard /api/stacks/:id/services/:svc/proc-tree", () => {
  it("returns the full subtree for an owned service", async () => {
    writeState("stack-a", { pid: 1001 });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/api/proc-tree",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: string;
      pid: number;
      process_count: number;
      mem_bytes: number;
      cpu_pct_cumulative: number;
      tree: {
        pid: number;
        rss_bytes: number;
        cpu_pct_cumulative: number;
        children: Array<{ pid: number; children: Array<{ pid: number }> }>;
      } | null;
    };
    expect(body.service).toBe("api");
    expect(body.pid).toBe(1001);
    // 1001 + 1002 + 1003 + 1004 = 4 procs
    expect(body.process_count).toBe(4);
    // sum of RSS: (10240 + 2048 + 1024 + 512) * 1024
    expect(body.mem_bytes).toBe((10240 + 2048 + 1024 + 512) * 1024);
    expect(body.tree).not.toBeNull();
    expect(body.tree!.pid).toBe(1001);
    expect(body.tree!.rss_bytes).toBe(10240 * 1024);
    const childPids = body.tree!.children.map((c) => c.pid).sort();
    expect(childPids).toEqual([1002, 1003]);
    const node1003 = body.tree!.children.find((c) => c.pid === 1003)!;
    expect(node1003.children.map((c) => c.pid)).toEqual([1004]);
  });

  it("returns 404 for unknown stack", async () => {
    writeState("stack-a", { pid: 1001 });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/nope/services/api/proc-tree",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown service", async () => {
    writeState("stack-a", { pid: 1001 });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/missing/proc-tree",
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for compose services", async () => {
    writeState("stack-a", {
      kind: "compose",
      serviceName: "postgres",
    });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/postgres/proc-tree",
    );
    expect(res.status).toBe(409);
  });

  it("returns null tree when pid is unset", async () => {
    writeState("stack-a", {});
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/api/proc-tree",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: unknown; pid: number };
    expect(body.tree).toBeNull();
    expect(body.pid).toBe(0);
  });

  it("returns null tree when pid is no longer in ps snapshot", async () => {
    writeState("stack-a", { pid: 5555 });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => PS_OUTPUT,
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/api/proc-tree",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tree: unknown;
      pid: number;
      process_count: number;
    };
    expect(body.tree).toBeNull();
    expect(body.pid).toBe(5555);
    expect(body.process_count).toBe(0);
  });

  it("returns 500 when the ps probe throws", async () => {
    writeState("stack-a", { pid: 1001 });
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      psProbe: async () => {
        throw new Error("ps unavailable");
      },
    });
    const res = await fetch(
      server.url + "/api/stacks/stack-a/services/api/proc-tree",
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Task 19c — /proc-tree endpoint dispatches via pickDataProvider (http path)
// ---------------------------------------------------------------------------

describe("dashboard /api/stacks/:id/services/:svc/proc-tree (sandbox/http provider)", () => {
  let upstream: { stop: () => void; url: string } | null = null;

  afterEach(() => {
    upstream?.stop();
    upstream = null;
  });

  function writeSandboxState(stackId: string, baseUrl: string, remoteStackId: string, pid?: number): void {
    const dir = join(stateRoot, stackId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        stack_id: stackId,
        worktree_name: "wt",
        worktree_path: "/tmp/wt",
        status: "up",
        started_at: "2026-05-31T00:00:00.000Z",
        services: [
          {
            name: "api",
            kind: "owned",
            state: "ready",
            ...(pid !== undefined ? { pid } : {}),
          },
        ],
        data_source: { kind: "http", base_url: baseUrl, stack_id: remoteStackId },
      }),
      "utf8",
    );
  }

  it("fetches proc-tree from the in-VM daemon for sandbox stacks", async () => {
    const remoteTree = {
      service: "api",
      pid: 200,
      process_count: 2,
      mem_bytes: 4096,
      cpu_pct_cumulative: 1.5,
      tree: { pid: 200, ppid: 1, rss_bytes: 4096, cpu_pct_cumulative: 1.5, children: [] },
    };
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req: Request): Response {
        const u = new URL(req.url);
        if (u.pathname === "/api/stacks/vm-stack-pt/services/api/proc-tree") {
          return new Response(JSON.stringify(remoteTree), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    upstream = { stop: () => s.stop(true), url: `http://127.0.0.1:${s.port}` };

    writeSandboxState("sandbox-pt-1", upstream.url, "vm-stack-pt", 200);

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(
      server.url + "/api/stacks/sandbox-pt-1/services/api/proc-tree",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.pid).toBe(200);
    expect(body.process_count).toBe(2);
    expect(body.mem_bytes).toBe(4096);
    expect(body.tree).not.toBeNull();
    expect(body.tree.pid).toBe(200);
  });

  it("returns 409 for compose services even on sandbox stacks", async () => {
    const dir = join(stateRoot, "sandbox-pt-compose");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        stack_id: "sandbox-pt-compose",
        worktree_name: "wt",
        worktree_path: "/tmp/wt",
        status: "up",
        started_at: "2026-05-31T00:00:00.000Z",
        services: [{ name: "postgres", kind: "compose", state: "healthy" }],
        data_source: { kind: "http", base_url: "http://127.0.0.1:1", stack_id: "vm-compose" },
      }),
      "utf8",
    );

    server = await startDashboardServer({ port: 0, stateRoot });

    const res = await fetch(
      server.url + "/api/stacks/sandbox-pt-compose/services/postgres/proc-tree",
    );
    expect(res.status).toBe(409);
  });
});
