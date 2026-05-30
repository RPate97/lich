import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForStackStatus } from "../helpers/state.js";
import { waitForDaemonRunning, readDaemonUrl } from "../helpers/daemon.js";
import { fetchDashboardJson } from "../helpers/dashboard-fetch.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

interface ServiceMetric {
  name: string;
  kind: "owned" | "compose";
  state: string;
  cpu_pct: number;
  mem_bytes: number;
  uptime_seconds: number;
  pid?: number;
  process_count?: number;
}

interface StackMetricsSnapshot {
  stack_id: string;
  sampled_at: string;
  total: { cpu_pct: number; mem_bytes: number };
  services: ServiceMetric[];
}

interface ProcTreeNode {
  pid: number;
  ppid: number;
  rss_bytes: number;
  cpu_pct_cumulative: number;
  children: ProcTreeNode[];
}

interface ProcTreeResponse {
  service: string;
  pid: number;
  process_count: number;
  mem_bytes: number;
  cpu_pct_cumulative: number;
  tree: ProcTreeNode | null;
}

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
});

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-dashboard-metrics-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`,
      err,
    );
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

describe("dashboard metrics endpoints — dogfood-stack", () => {
  it(
    "exposes per-service metrics + SSE stream + proc-tree drill-in",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up --no-browser (dev:fast — api + web on host)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 10_000 });
      step(`stack ${stackId} is up`);

      step("waiting for daemon");
      await waitForDaemonRunning(lichHome, { timeoutMs: 10_000 });

      // Wait for the sampler's first non-zero tick so the SSE + snapshot
      // contracts have something real to render.
      step("polling /api/stacks/<id>/metrics until non-zero memory");
      const deadline = Date.now() + 30_000;
      let snap: StackMetricsSnapshot | null = null;
      while (Date.now() < deadline) {
        try {
          snap = await fetchDashboardJson<StackMetricsSnapshot>(
            lichHome,
            `/api/stacks/${stackId}/metrics`,
          );
          if (
            snap.services.length > 0 &&
            snap.services.some((s) => s.mem_bytes > 0)
          ) {
            break;
          }
        } catch {
          /* keep polling */
        }
        await new Promise<void>((r) => setTimeout(r, 500));
      }
      expect(snap, "metrics endpoint never returned populated data").not.toBeNull();
      const apiSvc = snap!.services.find((s) => s.name === "api");
      const webSvc = snap!.services.find((s) => s.name === "web");
      expect(apiSvc).toBeDefined();
      expect(webSvc).toBeDefined();
      expect(apiSvc!.kind).toBe("owned");
      expect(apiSvc!.pid).toBeGreaterThan(0);
      expect(snap!.total.mem_bytes).toBeGreaterThan(0);
      step(`snapshot ok (api pid=${apiSvc!.pid}, web pid=${webSvc!.pid})`);

      step("SSE: /api/stacks/<id>/metrics/stream sends frames");
      const daemonUrl = readDaemonUrl(lichHome);
      expect(daemonUrl).toBeTruthy();
      const controller = new AbortController();
      const sseRes = await fetch(
        new URL(`/api/stacks/${stackId}/metrics/stream`, daemonUrl!).toString(),
        { signal: controller.signal },
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      const sseDeadline = Date.now() + 8_000;
      while (Date.now() < sseDeadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
        if (received.includes('"api"') && received.includes('"mem_bytes"')) {
          break;
        }
      }
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      expect(received).toContain('"stack_id"');
      expect(received).toContain('"api"');
      expect(received).toContain('"mem_bytes"');
      step("SSE frame received with api + mem_bytes");

      step("proc-tree drill-in for api");
      const procTree = await fetchDashboardJson<ProcTreeResponse>(
        lichHome,
        `/api/stacks/${stackId}/services/api/proc-tree`,
      );
      expect(procTree.service).toBe("api");
      expect(procTree.pid).toBe(apiSvc!.pid);
      expect(procTree.process_count).toBeGreaterThan(0);
      expect(procTree.mem_bytes).toBeGreaterThan(0);
      expect(procTree.tree).not.toBeNull();
      expect(procTree.tree!.pid).toBe(apiSvc!.pid);
      step(`proc-tree returned ${procTree.process_count} procs`);

      step("proc-tree on missing service → 404");
      let caught: unknown = null;
      try {
        await fetchDashboardJson<ProcTreeResponse>(
          lichHome,
          `/api/stacks/${stackId}/services/no-such-service/proc-tree`,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("404");
      step("404 negative case passed");

      step("dashboard UI is served (embedded SPA)");
      const indexRes = await fetch(daemonUrl!);
      expect(indexRes.status).toBe(200);
      const indexBody = await indexRes.text();
      // Vite-built SPA includes a hashed assets script.
      expect(indexBody).toContain('<div id="root">');
    },
    300_000,
  );
});
