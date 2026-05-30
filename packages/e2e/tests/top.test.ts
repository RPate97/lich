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
import { waitForDaemonRunning } from "../helpers/daemon.js";
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
  container_id?: string;
  mem_limit_bytes?: number;
}

interface StackMetricsSnapshot {
  stack_id: string;
  sampled_at: string;
  total: { cpu_pct: number; mem_bytes: number };
  services: ServiceMetric[];
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
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-top-home-"));
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
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
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

describe("lich top against dogfood-stack", () => {
  it(
    "returns parseable JSON with non-zero memory for owned services after a sample lands",
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

      // First sample fires inside the sampler's tick loop. Poll until the
      // endpoint returns services with non-zero memory (RSS) — that's the
      // signal the sampler walked the process tree successfully.
      step("polling /api/stacks/<id>/metrics until services have non-zero memory");
      const deadline = Date.now() + 30_000;
      let snap: StackMetricsSnapshot | null = null;
      while (Date.now() < deadline) {
        try {
          snap = await fetchDashboardJson<StackMetricsSnapshot>(
            lichHome,
            `/api/stacks/${stackId}/metrics`,
          );
          if (snap.services.length > 0 && snap.services.some((s) => s.mem_bytes > 0)) {
            break;
          }
        } catch {
          /* keep polling */
        }
        await new Promise<void>((r) => setTimeout(r, 500));
      }
      expect(snap, "metrics endpoint never returned populated data").not.toBeNull();
      const services = snap!.services;
      expect(services.length).toBeGreaterThanOrEqual(2);
      expect(services.some((s) => s.mem_bytes > 0)).toBe(true);

      step(`lich top --no-follow --json (services=${services.length})`);
      const topJsonResult = runLich(["top", "--no-follow", "--json"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(topJsonResult.exitCode).toBe(0);
      const topJson = JSON.parse(topJsonResult.stdout) as StackMetricsSnapshot;
      expect(topJson.stack_id).toBe(stackId);
      expect(topJson.services.length).toBeGreaterThanOrEqual(2);
      const apiSvc = topJson.services.find((s) => s.name === "api");
      const webSvc = topJson.services.find((s) => s.name === "web");
      expect(apiSvc).toBeDefined();
      expect(webSvc).toBeDefined();
      expect(apiSvc!.kind).toBe("owned");
      expect(webSvc!.kind).toBe("owned");
      expect(apiSvc!.mem_bytes).toBeGreaterThan(0);
      expect(webSvc!.mem_bytes).toBeGreaterThan(0);

      step("lich top --no-follow (table form)");
      const topTableResult = runLich(["top", "--no-follow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(topTableResult.exitCode).toBe(0);
      expect(topTableResult.stdout).toContain("SERVICE");
      expect(topTableResult.stdout).toContain("PID");
      expect(topTableResult.stdout).toContain("STATE");
      expect(topTableResult.stdout).toContain("CPU%");
      expect(topTableResult.stdout).toContain("MEM");
      expect(topTableResult.stdout).toContain("UPTIME");
      expect(topTableResult.stdout).toContain("TOTAL");
      expect(topTableResult.stdout).toContain("api");
      expect(topTableResult.stdout).toContain("web");
      step("table contains expected columns + services");
    },
    300_000,
  );

  it(
    "--all groups by stack header",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 10_000 });
      await waitForDaemonRunning(lichHome, { timeoutMs: 10_000 });

      // Brief wait for the first sample to populate.
      await new Promise<void>((r) => setTimeout(r, 2500));

      const result = runLich(["top", "--no-follow", "--all"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stack:");
      expect(result.stdout).toContain("api");
    },
    300_000,
  );
});
