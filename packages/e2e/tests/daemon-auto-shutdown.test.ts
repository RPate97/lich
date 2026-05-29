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
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import {
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "../helpers/daemon.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

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
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-daemon-auto-shutdown-home-"));
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

describe("lich daemon auto-shutdown", () => {
  it(
    "daemon exits within ~45s after the last stack stops, clearing PID + URL files",
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

      step("waiting for daemon PID + URL files");
      const daemonInfo = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      expect(daemonInfo.pid).toBeGreaterThan(0);
      expect(daemonInfo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      step(`daemon alive: pid=${daemonInfo.pid} url=${daemonInfo.url}`);

      const daemonPid = daemonInfo.pid;

      step("lich down (dev:fast — sub-second)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");

      // 30s grace = 3 ticks at 10s each; 45s budget with buffer
      step("waiting for daemon auto-shutdown (30s grace + buffer)");
      const t1 = Date.now();
      await waitForDaemonStopped(lichHome, { timeoutMs: 60_000 });
      const shutdownElapsedMs = Date.now() - t1;
      step(`daemon exited after ${(shutdownElapsedMs / 1000).toFixed(1)}s`);

      expect(
        shutdownElapsedMs,
        `daemon took ${(shutdownElapsedMs / 1000).toFixed(1)}s to auto-shutdown; expected ≤ 45s (30s grace + 15s buffer)`,
      ).toBeLessThanOrEqual(45_000);

      const pidPath = join(lichHome, "daemon.pid");
      const urlPath = join(lichHome, "daemon.url");
      expect(
        existsSync(pidPath),
        `expected daemon.pid to be cleared after auto-shutdown; found at ${pidPath}`,
      ).toBe(false);
      expect(
        existsSync(urlPath),
        `expected daemon.url to be cleared after auto-shutdown; found at ${urlPath}`,
      ).toBe(false);

      // signal 0 check: ESRCH = gone; EPERM = alive (shouldn't happen, own user)
      let isStillAlive = false;
      try {
        process.kill(daemonPid, 0);
        isStillAlive = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        isStillAlive = code === "EPERM";
      }
      expect(
        isStillAlive,
        `daemon process pid=${daemonPid} is still alive after PID file was cleared`,
      ).toBe(false);

      step("auto-shutdown verified end-to-end");
    },
    150_000,
  );
});
