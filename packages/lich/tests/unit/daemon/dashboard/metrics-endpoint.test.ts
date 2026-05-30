import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDashboardServer,
  type DashboardServer,
  type MetricsSamplerHandle,
} from "../../../../src/daemon/dashboard/server.js";
import type { StackMetricsSnapshot } from "../../../../src/daemon/metrics/types.js";

let stateRoot: string;
let server: DashboardServer | null = null;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-metrics-endpoint-"));
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

function writeState(stackId: string): void {
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
          name: "api",
          kind: "owned",
          state: "ready",
          pid: 9999,
        },
      ],
    }),
    "utf8",
  );
}

function fakeSampler(snap: StackMetricsSnapshot | null): MetricsSamplerHandle {
  return {
    latest: () => snap,
    subscribe: () => () => {},
  };
}

const sampleSnapshot: StackMetricsSnapshot = {
  stack_id: "stack-a",
  sampled_at: "2026-05-30T00:00:01.000Z",
  total: { cpu_pct: 12.3, mem_bytes: 1_000_000 },
  services: [
    {
      name: "api",
      kind: "owned",
      state: "ready",
      pid: 9999,
      cpu_pct: 12.3,
      mem_bytes: 1_000_000,
      uptime_seconds: 1,
      process_count: 1,
    },
  ],
};

describe("dashboard /api/stacks/:id/metrics", () => {
  it("returns 200 with the sampler's latest snapshot", async () => {
    writeState("stack-a");
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      metricsSampler: fakeSampler(sampleSnapshot),
    });
    const res = await fetch(server.url + "/api/stacks/stack-a/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StackMetricsSnapshot;
    expect(body.stack_id).toBe("stack-a");
    expect(body.services).toHaveLength(1);
    expect(body.services[0].name).toBe("api");
  });

  it("returns an empty-but-shaped payload while the sampler is still warming up", async () => {
    writeState("stack-a");
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      metricsSampler: fakeSampler(null),
    });
    const res = await fetch(server.url + "/api/stacks/stack-a/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StackMetricsSnapshot;
    expect(body.stack_id).toBe("stack-a");
    expect(body.services).toEqual([]);
    expect(body.total).toEqual({ cpu_pct: 0, mem_bytes: 0 });
  });

  it("returns 404 on unknown stack", async () => {
    writeState("stack-a");
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      metricsSampler: fakeSampler(sampleSnapshot),
    });
    const res = await fetch(server.url + "/api/stacks/nonexistent/metrics");
    expect(res.status).toBe(404);
  });

  it("returns 503 when no sampler is wired (defensive)", async () => {
    writeState("stack-a");
    server = await startDashboardServer({ port: 0, stateRoot });
    const res = await fetch(server.url + "/api/stacks/stack-a/metrics");
    expect(res.status).toBe(503);
  });
});

describe("dashboard /api/stacks/:id/metrics/stream", () => {
  it("emits an SSE frame for the latest sample on connect", async () => {
    writeState("stack-a");
    let onSnap: ((snap: StackMetricsSnapshot) => void) | null = null;
    const sampler: MetricsSamplerHandle = {
      latest: () => sampleSnapshot,
      subscribe: (_, cb) => {
        onSnap = cb;
        return () => {
          onSnap = null;
        };
      },
    };
    server = await startDashboardServer({
      port: 0,
      stateRoot,
      metricsSampler: sampler,
    });
    const controller = new AbortController();
    const res = await fetch(server.url + "/api/stacks/stack-a/metrics/stream", {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2000) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      if (received.includes("api")) break;
    }
    expect(received).toContain("stack-a");
    expect(received).toContain("api");
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  });
});
