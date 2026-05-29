import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runDaemon } from "../../../src/daemon/daemon.js";
import {
  readDaemonPid,
  readDaemonUrl,
  writeDaemonPid,
} from "../../../src/daemon/pid-file.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-daemon-main-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const DEAD_PID = 999_999;

function captureLog(): {
  stream: PassThrough;
  output: () => string;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function writeFakeStack(stackId: string, status: string): void {
  const stackDir = join(home, "stacks", stackId);
  mkdirSync(stackDir, { recursive: true });
  const snapshot = {
    stack_id: stackId,
    worktree_name: "test",
    worktree_path: "/tmp/test",
    status,
    started_at: new Date().toISOString(),
    services: [],
  };
  writeFileSync(
    join(stackDir, "state.json"),
    JSON.stringify(snapshot) + "\n",
    "utf8",
  );
}

function startDaemon(opts: {
  signal?: AbortSignal;
  out?: NodeJS.WritableStream;
  shutdownCheckMs?: number;
  shutdownGraceTicks?: number;
  proxyPort?: number;
}): Promise<{ exitCode: number }> {
  return runDaemon({
    lichHome: home,
    proxyPort: opts.proxyPort ?? 0,
    signal: opts.signal,
    out: opts.out,
    shutdownCheckMs: opts.shutdownCheckMs ?? 20,
    shutdownGraceTicks: opts.shutdownGraceTicks ?? 1,
  });
}

describe("runDaemon — PID file lifecycle", () => {
  it("writes the PID file with process.pid on startup", async () => {
    writeFakeStack("test-stack-1", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    expect(pid).toBe(process.pid);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("clears the PID file on clean shutdown via signal.abort", async () => {
    writeFakeStack("test-stack-2", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(await readDaemonPid({ lichHome: home })).toBeNull();
  });

  it("overwrites a stale PID file (dead PID) on startup", async () => {
    await writeDaemonPid(DEAD_PID, { lichHome: home });
    expect(await readDaemonPid({ lichHome: home })).toBe(DEAD_PID);

    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
    });

    let pid: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      pid = await readDaemonPid({ lichHome: home });
      if (pid !== null && pid !== DEAD_PID) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(pid).toBe(process.pid);

    controller.abort();
    await daemonPromise;
  });

  it("refuses to start when another daemon is already alive (PID = current process)", async () => {
    await writeDaemonPid(process.pid, { lichHome: home });

    const { stream } = captureLog();
    const result = await runDaemon({
      lichHome: home,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(1);
    // refuse-to-start must not overwrite the rightful owner's PID file
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
  });
});

describe("runDaemon — signal abort", () => {
  it("shuts down cleanly when signal is aborted", async () => {
    writeFakeStack("test-stack-3", "up");
    const controller = new AbortController();
    const { stream, output } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    const abortStart = Date.now();
    controller.abort();
    const result = await daemonPromise;
    const elapsed = Date.now() - abortStart;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(1_000);
    expect(output()).toContain("shutdown requested");
  });

  it("handles an already-aborted signal at startup (immediate shutdown)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    const start = Date.now();
    const result = await daemonPromise;
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

describe("runDaemon — auto-shutdown", () => {
  it("auto-shuts down when no alive stacks exist", async () => {
    const { stream, output } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toContain("auto-shutdown");
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("does NOT auto-shutdown when a stack with status=up exists", async () => {
    writeFakeStack("alive-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    await new Promise<void>((r) => setTimeout(r, 200));

    expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("does NOT auto-shutdown when a stack with status=starting exists", async () => {
    writeFakeStack("starting-stack", "starting");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    controller.abort();
    await daemonPromise;
  });

  it("DOES auto-shutdown when only stopped/failed stacks exist", async () => {
    writeFakeStack("done-stack", "stopped");
    writeFakeStack("broken-stack", "failed");
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("requires N consecutive empty ticks before shutting down", async () => {
    const { stream, output } = captureLog();

    const start = Date.now();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 30,
      shutdownGraceTicks: 3,
    });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThan(75);
    expect(output()).toContain("3 empty ticks");
  });
});

describe("runDaemon — real dashboard + proxy startup", () => {
  it("writes daemon.url with the dashboard URL after startup", async () => {
    writeFakeStack("test-stack-url", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // daemon reports IPv4 explicitly to dodge macOS localhost IPv6-resolution-order bug
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("dashboard URL is reachable: GET /healthz returns 200", async () => {
    writeFakeStack("test-stack-healthz", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
  });

  it("dashboard exposes primary_url derived from state.json routing entries", async () => {
    const stackDir = join(home, "stacks", "test-routing");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      join(stackDir, "state.json"),
      JSON.stringify({
        stack_id: "test-routing",
        worktree_name: "feature-x",
        worktree_path: "/tmp/wt",
        status: "up",
        started_at: new Date().toISOString(),
        services: [],
        routing: [
          {
            hostname: "api.feature-x",
            upstream_url: "http://127.0.0.1:9123",
            service: "api",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    let url: string | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    const res = await fetch(`${url}/api/stacks`);
    expect(res.status).toBe(200);
    const stacks = (await res.json()) as Array<{
      id: string;
      primary_url?: string;
    }>;
    const found = stacks.find((s) => s.id === "test-routing");
    expect(found).toBeDefined();
    expect(found?.primary_url).toMatch(
      /^http:\/\/api\.feature-x\.lich\.localhost:\d+\/$/,
    );

    controller.abort();
    await daemonPromise;
  });

  it("watcher onChange triggers BOTH dashboard refresh AND routing reload (post-startup state change)", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("hello from upstream", { status: 200 }),
    });
    const upstreamUrl = `http://127.0.0.1:${upstream.port}`;

    try {
      const controller = new AbortController();
      const { stream, output } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      let dashboardUrl: string | null = null;
      const startDeadline = Date.now() + 2_000;
      while (Date.now() < startDeadline) {
        dashboardUrl = await readDaemonUrl({ lichHome: home });
        if (dashboardUrl !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(dashboardUrl).not.toBeNull();

      const proxyMatch = output().match(
        /proxy listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );
      expect(proxyMatch).not.toBeNull();
      const proxyPort = Number(proxyMatch?.[1]);
      expect(proxyPort).toBeGreaterThan(0);

      const stackDir = join(home, "stacks", "added-stack");
      mkdirSync(stackDir, { recursive: true });
      writeFileSync(
        join(stackDir, "state.json"),
        JSON.stringify({
          stack_id: "added-stack",
          worktree_name: "added",
          worktree_path: "/tmp/added",
          status: "up",
          started_at: new Date().toISOString(),
          services: [],
          routing: [
            {
              hostname: "api.added",
              upstream_url: upstreamUrl,
              service: "api",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const friendlyUrlPattern =
        /^http:\/\/api\.added\.lich\.localhost:\d+\/$/;
      let dashboardOk = false;
      const refreshDeadline = Date.now() + 2_000;
      while (Date.now() < refreshDeadline) {
        const r = await fetch(`${dashboardUrl}/api/stacks`);
        const stacks = (await r.json()) as Array<{
          id: string;
          primary_url?: string;
        }>;
        const added = stacks.find((s) => s.id === "added-stack");
        if (added?.primary_url && friendlyUrlPattern.test(added.primary_url)) {
          dashboardOk = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(dashboardOk).toBe(true);

      let proxyOk = false;
      const proxyDeadline = Date.now() + 2_000;
      while (Date.now() < proxyDeadline) {
        try {
          const headers = new Headers();
          headers.set("Host", "api.added.lich.localhost");
          const r = await fetch(`http://127.0.0.1:${proxyPort}/`, {
            headers,
          });
          if (r.status === 200) {
            const body = await r.text();
            if (body === "hello from upstream") {
              proxyOk = true;
              break;
            }
          } else {
            await r.text().catch(() => {});
          }
        } catch {
          /* connection refused / reset — retry */
        }
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(proxyOk).toBe(true);

      controller.abort();
      await daemonPromise;
    } finally {
      upstream.stop(true);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  });

  it("uses the configured proxy port (binds proxy on requested port)", async () => {
    const { stream, output } = captureLog();

    const result = await runDaemon({
      lichHome: home,
      proxyPort: 0,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(output()).toMatch(/proxy listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(output()).toMatch(/dashboard listening on http:\/\/127\.0\.0\.1:\d+/);
  });

  it("derives a stable proxy port from LICH_HOME when proxyPort is unset", async () => {
    const { stream, output } = captureLog();

    const result = await runDaemon({
      lichHome: home,
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    const match = output().match(
      /proxy listening on http:\/\/127\.0\.0\.1:(\d+)/,
    );
    expect(match).not.toBeNull();
    const port = Number(match?.[1]);
    expect(port).toBeGreaterThan(0);
  });

  it("derives the SAME port on a second run with the same LICH_HOME (stability)", async () => {
    const { stream: s1, output: o1 } = captureLog();
    const r1 = await runDaemon({
      lichHome: home,
      out: s1,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });
    expect(r1.exitCode).toBe(0);
    const m1 = o1().match(/proxy listening on http:\/\/127\.0\.0\.1:(\d+)/);
    expect(m1).not.toBeNull();
    const port1 = Number(m1?.[1]);
    expect(port1).toBeGreaterThan(0);

    const { stream: s2, output: o2 } = captureLog();
    const r2 = await runDaemon({
      lichHome: home,
      out: s2,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });
    expect(r2.exitCode).toBe(0);
    const m2 = o2().match(/proxy listening on http:\/\/127\.0\.0\.1:(\d+)/);
    expect(m2).not.toBeNull();
    const port2 = Number(m2?.[1]);

    expect(port2).toBe(port1);
  });

  it("derives DIFFERENT ports for different LICH_HOMEs (multi-worktree isolation)", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "lich-daemon-main-alt-"));

    try {
      const { stream: s1, output: o1 } = captureLog();
      const r1 = await runDaemon({
        lichHome: home,
        out: s1,
        shutdownCheckMs: 20,
        shutdownGraceTicks: 1,
      });
      expect(r1.exitCode).toBe(0);
      const port1 = Number(
        o1().match(/proxy listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      );

      const { stream: s2, output: o2 } = captureLog();
      const r2 = await runDaemon({
        lichHome: home2,
        out: s2,
        shutdownCheckMs: 20,
        shutdownGraceTicks: 1,
      });
      expect(r2.exitCode).toBe(0);
      const port2 = Number(
        o2().match(/proxy listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      );

      expect(port1).toBeGreaterThan(0);
      expect(port2).toBeGreaterThan(0);
      expect(port1).not.toBe(port2);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

describe("runDaemon — shutdown teardown", () => {
  it("clears daemon.pid AND daemon.url on clean shutdown", async () => {
    writeFakeStack("teardown-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      if (
        existsSync(join(home, "daemon.pid")) &&
        existsSync(join(home, "daemon.url"))
      )
        break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    expect(existsSync(join(home, "daemon.url"))).toBe(true);

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(existsSync(join(home, "daemon.url"))).toBe(false);
    expect(await readDaemonUrl({ lichHome: home })).toBeNull();
  });

  it("stops the dashboard server on shutdown (URL becomes unreachable)", async () => {
    writeFakeStack("dashboard-stop-stack", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    let url: string | null = null;
    const startDeadline = Date.now() + 2_000;
    while (Date.now() < startDeadline) {
      url = await readDaemonUrl({ lichHome: home });
      if (url !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(url).not.toBeNull();

    const beforeRes = await fetch(`${url}/healthz`);
    expect(beforeRes.status).toBe(200);
    await beforeRes.text();

    controller.abort();
    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);

    let rejected = false;
    try {
      await fetch(`${url}/healthz`);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("runDaemon — concurrent abort safety", () => {
  it("survives multiple rapid signal.abort() calls without erroring", async () => {
    writeFakeStack("test-stack-4", "up");
    const controller = new AbortController();
    const { stream } = captureLog();

    const daemonPromise = startDaemon({
      signal: controller.signal,
      out: stream,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    controller.abort();
    controller.abort();
    controller.abort();

    const result = await daemonPromise;
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });

  it("running runDaemon twice sequentially leaves a clean state each time", async () => {
    const c1 = new AbortController();
    const { stream: s1 } = captureLog();
    const d1 = startDaemon({
      signal: c1.signal,
      out: s1,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline1 = Date.now() + 2_000;
    while (Date.now() < deadline1) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    c1.abort();
    const r1 = await d1;
    expect(r1.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    const c2 = new AbortController();
    const { stream: s2 } = captureLog();
    const d2 = startDaemon({
      signal: c2.signal,
      out: s2,
      shutdownCheckMs: 10_000,
      shutdownGraceTicks: 3,
    });
    const deadline2 = Date.now() + 2_000;
    while (Date.now() < deadline2) {
      if ((await readDaemonPid({ lichHome: home })) !== null) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(await readDaemonPid({ lichHome: home })).toBe(process.pid);
    c2.abort();
    const r2 = await d2;
    expect(r2.exitCode).toBe(0);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

describe("runDaemon — LICH_HOME env handling", () => {
  it("restores process.env.LICH_HOME on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    const sentinel = "/should-be-restored";
    process.env.LICH_HOME = sentinel;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBe(sentinel);
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });

  it("restores an UNSET LICH_HOME (delete) on clean shutdown", async () => {
    const prevHome = process.env.LICH_HOME;
    delete process.env.LICH_HOME;

    try {
      const controller = new AbortController();
      const { stream } = captureLog();

      const daemonPromise = startDaemon({
        signal: controller.signal,
        out: stream,
        shutdownCheckMs: 10_000,
        shutdownGraceTicks: 3,
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if ((await readDaemonPid({ lichHome: home })) !== null) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(process.env.LICH_HOME).toBe(home);

      controller.abort();
      await daemonPromise;
      expect(process.env.LICH_HOME).toBeUndefined();
    } finally {
      if (prevHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevHome;
      }
    }
  });
});

describe("runDaemon — state directory robustness", () => {
  it("treats unreadable/malformed state.json as not-alive (does not crash)", async () => {
    const stackDir = join(home, "stacks", "broken-stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "state.json"), "{ not valid json", "utf8");

    const { stream } = captureLog();
    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(
      readFileSync(join(stackDir, "state.json"), "utf8").includes("not valid"),
    ).toBe(true);
  });

  it("handles an empty stacks directory by auto-shutting down", async () => {
    mkdirSync(join(home, "stacks"), { recursive: true });
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
  });

  it("tolerates a missing stacks directory entirely", async () => {
    expect(existsSync(join(home, "stacks"))).toBe(false);
    const { stream } = captureLog();

    const result = await startDaemon({
      out: stream,
      shutdownCheckMs: 20,
      shutdownGraceTicks: 1,
    });

    expect(result.exitCode).toBe(0);
    // watcher.start() creates the stacks dir as a side effect
    expect(existsSync(join(home, "stacks"))).toBe(true);
  });
});
