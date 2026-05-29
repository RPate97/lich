import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForStackStatus } from "../helpers/state.js";
import { waitForDaemonRunning } from "../helpers/daemon.js";
import { fetchDashboardJson } from "../helpers/dashboard-fetch.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// Wire-format types duplicated locally (NOT imported) so drift gets caught.
interface StackViewService {
  name: string;
  kind: "owned" | "compose";
  state: string;
  failure_reason?: string;
  failure_log_tail?: string[];
  ports?: Record<string, number>;
}

interface StackView {
  id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services: StackViewService[];
  primary_url?: string;
  started_at?: string;
}

interface RoutingEntry {
  hostname: string;
  upstream_url: string;
  service: string;
}

const lichDaemonBinary = resolve(repoRoot, "packages/lich/dist/lich-daemon");

beforeAll(() => {
  if (!existsSync(lichBinary)) {
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
    if (!existsSync(lichBinary)) {
      throw new Error(
        `lich build reported success but ${lichBinary} does not exist`,
      );
    }
  }
  if (!existsSync(lichDaemonBinary)) {
    const build = spawnSync("bun", ["run", "build:daemon"], {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
      timeout: 120_000,
    });
    if (build.status !== 0) {
      throw new Error(
        `failed to build lich-daemon binary (exit ${build.status}); cannot run e2e tests`,
      );
    }
    if (!existsSync(lichDaemonBinary)) {
      throw new Error(
        `lich-daemon build reported success but ${lichDaemonBinary} does not exist`,
      );
    }
  }
});

interface StackCopy {
  path: string;
  cleanup: () => void;
}

let lichHome: string | null = null;
let stackA: StackCopy | null = null;
let stackB: StackCopy | null = null;
let daemonInfo: { pid: number; url: string } | null = null;

// PID-derived to avoid collisions with sibling daemons holding 3300.
function pickProxyPort(): number {
  return 50_000 + (process.pid % 10_000);
}

let proxyPort: number | null = null;

const t0 = Date.now();
function step(label: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`  [+${elapsed}s] ${label}\n`);
}

function lichUp(cwd: string): ReturnType<typeof runLich> {
  return runLich(["up", "--no-browser"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    timeout: 60_000,
  });
}

function readStateForWorktree(
  worktreePath: string,
): {
  stack_id: string;
  worktree_name: string;
  status: string;
  services: Array<{
    name: string;
    state: string;
    allocated_ports?: Record<string, number>;
  }>;
  routing?: RoutingEntry[];
} | null {
  const stacksRoot = join(lichHome!, "stacks");
  if (!existsSync(stacksRoot)) return null;

  for (const entry of readdirSync(stacksRoot)) {
    const dir = join(stacksRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const statePath = join(dir, "state.json");
    if (!existsSync(statePath)) continue;
    try {
      const snap = JSON.parse(readFileSync(statePath, "utf8")) as {
        stack_id: string;
        worktree_name: string;
        worktree_path: string;
        status: string;
        services: Array<{
          name: string;
          state: string;
          allocated_ports?: Record<string, number>;
        }>;
        routing?: RoutingEntry[];
      };
      // macOS realpath collapse: /var/folders/X may also be /private/var/folders/X
      if (
        snap.worktree_path === worktreePath ||
        snap.worktree_path.endsWith(worktreePath) ||
        worktreePath.endsWith(snap.worktree_path)
      ) {
        return snap;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch via proxy with explicit Host header. Uses http.request rather than
 * fetch because undici silently strips the `Host` header (WHATWG forbidden).
 */
async function fetchViaProxy(
  proxyPort: number,
  friendlyHostname: string,
  path: string,
): Promise<{ status: number; text: () => Promise<string> }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
        method: "GET",
        headers: {
          Host: `${friendlyHostname}:${proxyPort}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            text: async () => body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterAll(() => {
  if (stackA && lichHome) {
    try {
      spawnSync(lichBinary, ["nuke", "--yes"], {
        cwd: stackA.path,
        env: { ...process.env, LICH_HOME: lichHome },
        timeout: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }
  for (const stack of [stackA, stackB]) {
    if (!stack) continue;
    try {
      stack.cleanup();
    } catch {
      /* best-effort */
    }
  }
  if (lichHome && existsSync(lichHome)) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  stackA = null;
  stackB = null;
  lichHome = null;
  daemonInfo = null;
  proxyPort = null;
});

describe("dashboard + friendly URLs with two parallel stacks", () => {
  it(
    "(setup-a) lich up A under shared LICH_HOME; daemon spawns",
    async () => {
      lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-dashboard-parallel-home-"),
      );

      // Distinct basenames so worktree slugs differ → distinct friendly
      // hostnames → no proxy routing collisions.
      step("preparing tmpdir copies + bun install (~20s)");
      stackA = copyExampleToTmpdir("dogfood-stack", {
        prefix: "lich-e2e-plan5-a-",
        install: true,
      });
      stackB = copyExampleToTmpdir("dogfood-stack", {
        prefix: "lich-e2e-plan5-b-",
        install: true,
      });

      // Pin proxy_port in both yamls; default 3300 would collide with
      // stray daemons under parallel test execution.
      proxyPort = pickProxyPort();
      for (const stack of [stackA, stackB]) {
        const yamlPath = join(stack.path, "lich.yaml");
        const orig = readFileSync(yamlPath, "utf8");
        const updated = orig.replace(
          /(\n\s*)proxy_port:\s*\d+/,
          `$1proxy_port: ${proxyPort}`,
        );
        if (updated === orig) {
          throw new Error(
            `failed to substitute proxy_port in ${yamlPath} — did the dogfood-stack stop pinning runtime.proxy_port?`,
          );
        }
        writeFileSync(yamlPath, updated, "utf8");
      }
      step(`pinned proxy_port=${proxyPort} in both lich.yamls`);

      step("lich up A --no-browser (dev:fast — api + web on host)");
      const upA = lichUp(stackA.path);
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up A exited ${upA.exitCode}\n` +
            `--- stdout ---\n${upA.stdout}\n` +
            `--- stderr ---\n${upA.stderr}`,
        );
      }
      const stateA = readStateForWorktree(stackA.path);
      expect(stateA, "state.json for A should exist after up").not.toBeNull();
      expect(stateA!.status).toBe("up");
      step(
        `A up (stack_id=${stateA!.stack_id}, worktree=${stateA!.worktree_name})`,
      );

      // dev:fast sentinel (catches profile drift)
      const urlsA = runLich(["urls", "--raw"], {
        cwd: stackA.path,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsA.exitCode).toBe(0);
      const parsedA = parseLichUrls(urlsA.stdout);
      const apiUrlA = parsedA.api;
      expect(apiUrlA, `expected api url for A in: ${urlsA.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrlA}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrlA!, "stub");
      step("A api /health reports db: stub");

      step("waiting for daemon (pid + url files)");
      daemonInfo = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      expect(daemonInfo.url).toMatch(
        /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/,
      );
      step(`daemon up: pid=${daemonInfo.pid} url=${daemonInfo.url}`);
    },
    90_000,
  );

  it(
    "(setup-b) lich up B under the SAME LICH_HOME; daemon is shared",
    async () => {
      expect(lichHome, "lichHome — setup-a must have run").not.toBeNull();
      expect(stackB, "stackB — setup-a must have run").not.toBeNull();
      expect(daemonInfo, "daemonInfo — setup-a must have run").not.toBeNull();

      step("lich up B --no-browser (shared daemon already running)");
      const upB = lichUp(stackB!.path);
      if (upB.exitCode !== 0) {
        throw new Error(
          `lich up B exited ${upB.exitCode}\n` +
            `--- stdout ---\n${upB.stdout}\n` +
            `--- stderr ---\n${upB.stderr}`,
        );
      }
      const stateB = readStateForWorktree(stackB!.path);
      expect(stateB, "state.json for B should exist after up").not.toBeNull();
      expect(stateB!.status).toBe("up");
      step(
        `B up (stack_id=${stateB!.stack_id}, worktree=${stateB!.worktree_name})`,
      );

      const stateA = readStateForWorktree(stackA!.path);
      expect(stateA, "A's state.json should survive B's up").not.toBeNull();
      expect(stateA!.status).toBe("up");
      expect(stateA!.stack_id).not.toBe(stateB!.stack_id);

      // Singleton contract: daemon URL/PID unchanged across both ups.
      const daemonAfterB = await waitForDaemonRunning(lichHome!, {
        timeoutMs: 5_000,
      });
      expect(
        daemonAfterB.url,
        `daemon URL should be unchanged after B's up; was ${daemonInfo!.url}, now ${daemonAfterB.url}`,
      ).toBe(daemonInfo!.url);
      expect(
        daemonAfterB.pid,
        `daemon PID should be unchanged after B's up; was ${daemonInfo!.pid}, now ${daemonAfterB.pid}`,
      ).toBe(daemonInfo!.pid);
      step("daemon unchanged — singleton contract holds");

      // dev:fast sentinel for B (catches env leakage between ups)
      const urlsB = runLich(["urls", "--raw"], {
        cwd: stackB!.path,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsB.exitCode).toBe(0);
      const parsedB = parseLichUrls(urlsB.stdout);
      const apiUrlB = parsedB.api;
      expect(apiUrlB, `expected api url for B in: ${urlsB.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrlB}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrlB!, "stub");
      step("B api /health reports db: stub");
    },
    90_000,
  );

  it(
    "(assert) /api/stacks lists both; each friendly URL hits its own upstream",
    async () => {
      expect(lichHome, "lichHome — setup must have run").not.toBeNull();
      expect(stackA, "stackA — setup must have run").not.toBeNull();
      expect(stackB, "stackB — setup must have run").not.toBeNull();

      expect(proxyPort, "proxyPort — setup-a must have run").not.toBeNull();
      const pp = proxyPort!;

      const stateA = readStateForWorktree(stackA!.path);
      const stateB = readStateForWorktree(stackB!.path);
      expect(stateA, "state.json for A").not.toBeNull();
      expect(stateB, "state.json for B").not.toBeNull();
      await waitForStackStatus(lichHome!, stateA!.stack_id, "up", {
        timeoutMs: 10_000,
      });
      await waitForStackStatus(lichHome!, stateB!.stack_id, "up", {
        timeoutMs: 10_000,
      });

      // dashboard cache lags state.json by the watcher's ~100ms debounce
      step("waiting for dashboard cache to reflect both stacks up");
      const dashboardReadyDeadline = Date.now() + 10_000;
      let dashboardReadyLast: StackView[] = [];
      while (Date.now() < dashboardReadyDeadline) {
        try {
          dashboardReadyLast = await fetchDashboardJson<StackView[]>(
            lichHome!,
            "/api/stacks",
          );
          const a = dashboardReadyLast.find((s) => s.id === stateA!.stack_id);
          const b = dashboardReadyLast.find((s) => s.id === stateB!.stack_id);
          if (a?.status === "up" && b?.status === "up") break;
        } catch {
          // transient fetch error → retry until the outer deadline
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (Date.now() >= dashboardReadyDeadline) {
        throw new Error(
          `timeout waiting for /api/stacks to show both stacks up; ` +
            `last response: ${JSON.stringify(
              dashboardReadyLast.map((s) => ({ id: s.id, status: s.status })),
            )}`,
        );
      }

      step("fetching /api/stacks");
      const stacks = await fetchDashboardJson<StackView[]>(
        lichHome!,
        "/api/stacks",
      );
      expect(Array.isArray(stacks)).toBe(true);
      expect(
        stacks.length,
        `expected exactly two stacks in /api/stacks; got ${stacks.length}: ${JSON.stringify(stacks.map((s) => s.id))}`,
      ).toBe(2);

      const apiStackA = stacks.find((s) => s.id === stateA!.stack_id);
      const apiStackB = stacks.find((s) => s.id === stateB!.stack_id);
      expect(
        apiStackA,
        `/api/stacks missing entry for A (stack_id=${stateA!.stack_id}); got ${JSON.stringify(stacks)}`,
      ).toBeDefined();
      expect(
        apiStackB,
        `/api/stacks missing entry for B (stack_id=${stateB!.stack_id}); got ${JSON.stringify(stacks)}`,
      ).toBeDefined();
      expect(apiStackA!.status).toBe("up");
      expect(apiStackB!.status).toBe("up");
      expect(apiStackA!.worktree_name).toBe(stateA!.worktree_name);
      expect(apiStackB!.worktree_name).toBe(stateB!.worktree_name);
      expect(apiStackA!.worktree_name).not.toBe(apiStackB!.worktree_name);
      step(
        `/api/stacks lists both: ${apiStackA!.worktree_name} + ${apiStackB!.worktree_name}`,
      );

      const routingA = stateA!.routing ?? [];
      const routingB = stateB!.routing ?? [];
      expect(
        routingA.length,
        `A should have routing entries after up; got 0`,
      ).toBeGreaterThan(0);
      expect(
        routingB.length,
        `B should have routing entries after up; got 0`,
      ).toBeGreaterThan(0);

      const apiEntryA = routingA.find((r) => r.service === "api");
      const apiEntryB = routingB.find((r) => r.service === "api");
      expect(
        apiEntryA,
        `A's routing should include an api entry; got ${JSON.stringify(routingA)}`,
      ).toBeDefined();
      expect(
        apiEntryB,
        `B's routing should include an api entry; got ${JSON.stringify(routingB)}`,
      ).toBeDefined();

      expect(apiEntryA!.hostname).toBe(`api.${stateA!.worktree_name}`);
      expect(apiEntryB!.hostname).toBe(`api.${stateB!.worktree_name}`);
      expect(apiEntryA!.hostname).not.toBe(apiEntryB!.hostname);
      step(
        `distinct hostnames: ${apiEntryA!.hostname} vs ${apiEntryB!.hostname}`,
      );

      expect(apiEntryA!.upstream_url).not.toBe(apiEntryB!.upstream_url);

      // proxy routing table updates on the watcher's debounce; poll
      step("waiting for proxy routing to register both A + B api routes");
      const routingReadyDeadline = Date.now() + 10_000;
      let lastStatusA = 0;
      let lastStatusB = 0;
      while (Date.now() < routingReadyDeadline) {
        try {
          const ra = await fetchViaProxy(
            pp,
            `${apiEntryA!.hostname}.lich.localhost`,
            "/health",
          );
          lastStatusA = ra.status;
          const rb = await fetchViaProxy(
            pp,
            `${apiEntryB!.hostname}.lich.localhost`,
            "/health",
          );
          lastStatusB = rb.status;
          if (ra.status === 200 && rb.status === 200) break;
        } catch {
          // transient fetch error → retry until the outer deadline
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (Date.now() >= routingReadyDeadline) {
        throw new Error(
          `timeout waiting for proxy to route both stacks' api; ` +
            `last A status=${lastStatusA}, last B status=${lastStatusB}`,
        );
      }

      // /health body is deterministic across stacks. To prove "different
      // upstreams" we chain: (a) both return 200, (b) proxied body matches
      // raw upstream body, (c) unknown hostname returns 404.
      const friendlyHostA = `${apiEntryA!.hostname}.lich.localhost`;
      const friendlyHostB = `${apiEntryB!.hostname}.lich.localhost`;

      step(`probing A via proxy Host:${friendlyHostA}`);
      const resProxyA = await fetchViaProxy(
        pp,
        friendlyHostA,
        "/health",
      );
      expect(
        resProxyA.status,
        `proxy returned ${resProxyA.status} for ${friendlyHostA}; expected 200`,
      ).toBe(200);
      const bodyProxyA = await resProxyA.text();

      step(`probing B via proxy Host:${friendlyHostB}`);
      const resProxyB = await fetchViaProxy(
        pp,
        friendlyHostB,
        "/health",
      );
      expect(
        resProxyB.status,
        `proxy returned ${resProxyB.status} for ${friendlyHostB}; expected 200`,
      ).toBe(200);
      const bodyProxyB = await resProxyB.text();

      step(`probing A raw upstream ${apiEntryA!.upstream_url}/health`);
      const resRawA = await fetch(`${apiEntryA!.upstream_url}/health`);
      expect(resRawA.status).toBe(200);
      const bodyRawA = await resRawA.text();

      step(`probing B raw upstream ${apiEntryB!.upstream_url}/health`);
      const resRawB = await fetch(`${apiEntryB!.upstream_url}/health`);
      expect(resRawB.status).toBe(200);
      const bodyRawB = await resRawB.text();

      expect(
        bodyProxyA,
        `proxied A body should match raw A upstream body; got proxied=${JSON.stringify(bodyProxyA)} raw=${JSON.stringify(bodyRawA)}`,
      ).toBe(bodyRawA);
      expect(
        bodyProxyB,
        `proxied B body should match raw B upstream body; got proxied=${JSON.stringify(bodyProxyB)} raw=${JSON.stringify(bodyRawB)}`,
      ).toBe(bodyRawB);

      step("probing nonexistent friendly hostname (expect 404)");
      const resMiss = await fetchViaProxy(
        pp,
        "api.nonexistent-worktree-xyz.lich.localhost",
        "/health",
      );
      expect(
        resMiss.status,
        `proxy should 404 for a hostname not in routing; got ${resMiss.status}`,
      ).toBe(404);
      step("404 negative case passed");

      step("both friendly URLs route to their own upstreams — sentinel passed");
    },
    60_000,
  );

  it(
    "(teardown) lich nuke --yes tears down both stacks + the shared daemon",
    () => {
      if (!stackA || !lichHome) return;

      step("lich nuke --yes (tears down both stacks + daemon)");
      const nukeResult = runLich(["nuke", "--yes"], {
        cwd: stackA.path,
        env: { LICH_HOME: lichHome },
        timeout: 180_000,
      });
      if (nukeResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich nuke stdout:", nukeResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich nuke stderr:", nukeResult.stderr);
      }
      expect(nukeResult.exitCode).toBe(0);
      step("nuke exit 0");
    },
    200_000,
  );
});
