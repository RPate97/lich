import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// Wire-format types — duplicated locally (NOT imported) so drift gets caught.
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

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  const variantPath = resolve(
    repoRoot,
    "packages/e2e/fixtures/dogfood-stack/lich-failing-variant.yaml",
  );
  const variantYaml = readFileSync(variantPath, "utf8");
  writeFileSync(join(stack.path, "lich.yaml"), variantYaml, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-dashboard-failed-service-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich nuke failed for ${fix.stackPath}:`, err);
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

/**
 * Spawn lich-daemon detached + unref'd. Mirrors production auto-start
 * (`packages/lich/src/daemon/auto-start.ts`). Required because the failure
 * path of `lich up` doesn't auto-start the daemon — its trigger sits after
 * `state.status = "up"` and the per-level failure path returns earlier.
 */
function spawnDaemon(lichHome: string): void {
  const child = spawn(lichDaemonBinary, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LICH_HOME: lichHome,
    },
  });
  child.unref();
}

describe("dashboard renders failed service with reason", () => {
  it(
    "GET /api/stacks/:id surfaces the broken service with state:failed, failure_reason, and failure_log_tail",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up --no-browser (expects non-zero exit)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error(
          "lich up unexpectedly succeeded; stdout was:",
          upResult.stdout,
        );
        // eslint-disable-next-line no-console
        console.error("stderr was:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);
      step(`lich up exit ${upResult.exitCode} (as expected)`);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      step(`stack id: ${stackId}`);

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 3_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const brokenSnap = snap.services.find((s) => s.name === "broken");
      expect(
        brokenSnap,
        `expected 'broken' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(brokenSnap!.state).toBe("failed");
      step("state.json: broken=failed with failure metadata");

      step("spawning lich-daemon manually");
      spawnDaemon(lichHome);

      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 15_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      step(`fetching /api/stacks/${stackId}`);
      const stack = await fetchDashboardJson<StackView>(
        lichHome,
        `/api/stacks/${stackId}`,
      );

      expect(stack.id).toBe(stackId);
      expect(stack.status).toBe("failed");

      expect(stack.services).toHaveLength(1);
      const broken = stack.services[0];
      expect(broken.name).toBe("broken");
      expect(broken.kind).toBe("owned");
      expect(broken.state).toBe("failed");

      // Assert on "code 1" not exact prose — tolerates copy tweaks but
      // catches regressions that drop the exit code.
      expect(broken.failure_reason).toBeDefined();
      expect(broken.failure_reason).toContain("code 1");

      // log_tail may be empty (shell can fold echo into exit syscall),
      // but it must be an array — not undefined or a joined string.
      expect(broken.failure_log_tail).toBeDefined();
      expect(Array.isArray(broken.failure_log_tail)).toBe(true);

      step("all /api/stacks/:id failure-projection assertions passed");
    },
    120_000,
  );
});
