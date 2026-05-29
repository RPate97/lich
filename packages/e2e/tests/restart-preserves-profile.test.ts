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
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

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

function makeFixture(prefix = "lich-e2e-restart-profile-"): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", {
    prefix,
    install: true,
  });
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
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
  } catch {
    /* best-effort */
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach LICH_HOME cleanup failed:`, err);
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

describe("lich restart preserves the active profile (LEV-517)", () => {
  it(
    "restart re-uses the active_profile from state.json — dev:fast stays dev:fast",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up dev:fast (api + web, no postgres)");
      const upResult = runLich(["up", "dev:fast", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up dev:fast stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up dev:fast stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snapBefore = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snapBefore.active_profile).toBe("dev:fast");
      const servicesBefore = snapBefore.services.map((s) => s.name).sort();
      expect(servicesBefore).toEqual(["api", "web"]);
      step("pre-restart snapshot verified: active_profile=dev:fast, services=[api,web]");

      step("lich restart (down + up; profile preserved from snapshot)");
      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 180_000,
      });
      if (restartResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich restart stdout:", restartResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich restart stderr:", restartResult.stderr);
      }
      expect(restartResult.exitCode).toBe(0);
      step("lich restart exit 0");

      const snapAfter = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });

      expect(
        snapAfter.active_profile,
        "restart must preserve the active_profile from the prior snapshot",
      ).toBe("dev:fast");

      const servicesAfter = snapAfter.services.map((s) => s.name).sort();
      expect(
        servicesAfter,
        "restart must bring up the same service set as before (dev:fast = api + web)",
      ).toEqual(["api", "web"]);

      for (const svc of snapAfter.services) {
        expect(
          svc.state,
          `service ${svc.name} must be ready after restart`,
        ).toBe("ready");
      }
      step("post-restart assertions complete");
    },
    300_000,
  );

  it(
    "restart --profile <name> overrides the snapshotted profile",
    async () => {
      fixture = makeFixture("lich-e2e-restart-override-");
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up dev:fast (api + web)");
      const upResult = runLich(["up", "dev:fast", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
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
      const snapBefore = readStateJson(lichHome, stackId!);
      expect(snapBefore?.active_profile).toBe("dev:fast");
      step("pre-restart snapshot: active_profile=dev:fast");

      step("lich restart --profile dev:fast (explicit override — same profile in this case)");
      const restartResult = runLich(["restart", "--profile", "dev:fast"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 180_000,
      });
      if (restartResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich restart stdout:", restartResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich restart stderr:", restartResult.stderr);
      }
      expect(restartResult.exitCode).toBe(0);
      step("lich restart exit 0");

      const snapAfter = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(
        snapAfter.active_profile,
        "explicit profile arg must be used (not the snapshotted one)",
      ).toBe("dev:fast");
      step("post-restart explicit-profile assertion complete");
    },
    300_000,
  );
});
