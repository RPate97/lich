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
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
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
    join(tmpdir(), "lich-e2e-dashboard-stack-detail-home-"),
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
  // nuke kills the daemon (kills stale daemon.pid/daemon.url)
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

describe("dashboard /api/stacks/:id against dogfood-stack", () => {
  it(
    "returns one StackView with per-service detail including ports + primary_url",
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
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");

      // dev:fast sentinel: db should be "stub" (catches profile drift)
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
      step("api /health reports db: stub");

      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 10_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      step(`fetching /api/stacks/${stackId}`);
      const stack = await fetchDashboardJson<StackView>(
        lichHome,
        `/api/stacks/${stackId}`,
      );

      expect(stack.id).toBe(stackId);

      expect(stack.worktree_name).toMatch(/^[a-z0-9-]+$/);
      expect(stack.worktree_name.length).toBeGreaterThan(0);
      expect(stack.worktree_name).toBe(snap.worktree_name);

      expect(stack.status).toBe("up");

      expect(stack.active_profile).toBe("dev:fast");

      const serviceNames = stack.services.map((s) => s.name).sort();
      expect(serviceNames).toEqual(["api", "web"]);

      const expectedKinds: Record<string, "owned" | "compose"> = {
        api: "owned",
        web: "owned",
      };

      for (const svc of stack.services) {
        expect(
          svc.kind,
          `service ${svc.name} kind mismatch`,
        ).toBe(expectedKinds[svc.name]);
        expect(svc.state).toBe("ready");
      }

      // projectService renames allocated_ports → ports; verify per service.
      for (const snapSvc of snap.services) {
        const wireSvc = stack.services.find((s) => s.name === snapSvc.name);
        expect(wireSvc).toBeDefined();
        if (
          snapSvc.allocated_ports &&
          Object.keys(snapSvc.allocated_ports).length > 0
        ) {
          expect(wireSvc!.ports).toEqual(snapSvc.allocated_ports);
          for (const port of Object.values(wireSvc!.ports!)) {
            expect(typeof port).toBe("number");
            expect(port).toBeGreaterThan(0);
          }
        } else {
          // projectService omits ports when empty (not emit `{}`)
          expect(wireSvc!.ports).toBeUndefined();
        }
      }

      expect(stack.primary_url).toBeDefined();
      expect(stack.primary_url).toMatch(
        /^http:\/\/[a-z0-9-]+\.[a-z0-9-]+\.lich\.localhost:\d+\/$/,
      );

      expect(stack.started_at).toBeDefined();
      expect(Number.isNaN(Date.parse(stack.started_at!))).toBe(false);

      step("all /api/stacks/:id assertions passed");

      step("fetching /api/stacks/nonexistent-id (expect 404)");
      let caught: unknown = null;
      try {
        await fetchDashboardJson<StackView>(
          lichHome,
          "/api/stacks/nonexistent-id",
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("404");
      step("404 negative case passed");
    },
    60_000,
  );
});
