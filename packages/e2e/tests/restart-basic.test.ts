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
import { waitForHttp200 } from "../helpers/wait.js";
import { parseLichUrls } from "../helpers/urls.js";
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { expectDbMode } from "../helpers/dbmode.js";
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

function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-restart-basic-home-"));
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
  // nuke catches partial-up state where down may have missed processes
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

describe("lich restart against dogfood-stack", () => {
  it(
    "tears the stack down and brings it back up under the same stack_id",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up #1 (postgres pull + boot ~5-10s)");
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up #1 stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up #1 stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up #1 exit 0");

      // capture pre-restart state
      const stackIdBefore = findStackId(lichHome);
      expect(stackIdBefore).not.toBeNull();
      const snapBefore = await waitForStackStatus(
        lichHome,
        stackIdBefore!,
        "up",
        { timeoutMs: 10_000 },
      );
      expect(snapBefore.status).toBe("up");

      const apiBefore = snapBefore.services.find((s) => s.name === "api");
      expect(apiBefore?.state).toBe("ready");
      // single-port owned services land under `default` key
      const apiPortBefore = apiBefore?.allocated_ports?.default;
      expect(
        apiPortBefore,
        `expected api to have an allocated port before restart`,
      ).toBeTruthy();

      // record owned PIDs to verify they change after restart
      const pidsBefore = new Map<string, number>();
      for (const svc of snapBefore.services) {
        if (svc.kind === "owned" && typeof svc.pid === "number") {
          pidsBefore.set(svc.name, svc.pid);
        }
      }
      expect(pidsBefore.size).toBeGreaterThan(0);

      step(`probing api /health pre-restart (port ${apiPortBefore})`);
      await waitForHttp200(`http://127.0.0.1:${apiPortBefore}/health`, {
        timeoutMs: 15_000,
      });
      await expectDbMode(`http://127.0.0.1:${apiPortBefore}`, "stub");

      step("lich restart (down + up; warm postgres ~3-5s)");
      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 360_000,
      });
      if (restartResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich restart stdout:", restartResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich restart stderr:", restartResult.stderr);
      }
      expect(restartResult.exitCode).toBe(0);
      step("lich restart exit 0");

      // same stack_id (worktree identity preserved across restart)
      const stackIdAfter = findStackId(lichHome);
      expect(stackIdAfter).toBe(stackIdBefore);

      const snapAfter = await waitForStackStatus(
        lichHome,
        stackIdAfter!,
        "up",
        { timeoutMs: 10_000 },
      );
      expect(snapAfter.status).toBe("up");

      const namesBefore = snapBefore.services.map((s) => s.name).sort();
      const namesAfter = snapAfter.services.map((s) => s.name).sort();
      expect(namesAfter).toEqual(namesBefore);
      for (const svc of snapAfter.services) {
        expect(
          svc.state,
          `service ${svc.name} did not reach ready after restart`,
        ).toBe("ready");
      }

      // owned PIDs must change (proves restart actually re-spawned)
      let changedPidCount = 0;
      for (const svc of snapAfter.services) {
        if (svc.kind !== "owned" || typeof svc.pid !== "number") continue;
        const oldPid = pidsBefore.get(svc.name);
        if (oldPid !== undefined) {
          expect(
            svc.pid,
            `service ${svc.name} kept the same PID across restart (was ${oldPid})`,
          ).not.toBe(oldPid);
          changedPidCount++;
        }
      }
      expect(changedPidCount).toBeGreaterThan(0);

      // verify stack actually serves traffic again
      const apiAfter = snapAfter.services.find((s) => s.name === "api");
      const apiPortAfter = apiAfter?.allocated_ports?.default;
      expect(
        apiPortAfter,
        `expected api to have an allocated port after restart`,
      ).toBeTruthy();
      step(`probing api /health post-restart (port ${apiPortAfter})`);
      await waitForHttp200(`http://127.0.0.1:${apiPortAfter}/health`, {
        timeoutMs: 30_000,
      });
      const health = await fetch(
        `http://127.0.0.1:${apiPortAfter}/health`,
      ).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok" });

      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      expect(Object.keys(urls).sort()).toEqual(
        expect.arrayContaining(["api", "web"]),
      );
      step("post-restart assertions complete");

      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(downResult.exitCode).toBe(0);

      const downSnap = readStateJson(lichHome, stackIdAfter!);
      expect(downSnap?.status).toBe("stopped");
      step("lich down complete; stack stopped");
    },
    600_000,
  );
});
