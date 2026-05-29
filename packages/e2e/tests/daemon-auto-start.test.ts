import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import {
  readDaemonUrl,
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "../helpers/daemon.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
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

let stackPath: string | null = null;
let stackCleanup: (() => void) | null = null;
let lichHome: string | null = null;

afterAll(() => {
  if (stackPath && lichHome) {
    try {
      spawnSync(lichBinary, ["nuke", "--yes"], {
        cwd: stackPath,
        env: { ...process.env, LICH_HOME: lichHome },
        timeout: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }
  if (stackCleanup) {
    try {
      stackCleanup();
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
  stackPath = null;
  stackCleanup = null;
  lichHome = null;
});

const t0 = Date.now();
function step(label: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`  [+${elapsed}s] ${label}\n`);
}

describe("daemon auto-start on first `lich up`", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-suite LICH_HOME with --no-browser",
    async () => {
      const copied = copyExampleToTmpdir("dogfood-stack", { install: true });
      stackPath = copied.path;
      stackCleanup = copied.cleanup;
      lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-daemon-auto-start-home-"),
      );

      step("lich up --no-browser (dev:fast — api + web on host)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        throw new Error(
          `lich up failed (exit ${upResult.exitCode})\n` +
            `--- stdout ---\n${upResult.stdout}\n` +
            `--- stderr ---\n${upResult.stderr}`,
        );
      }
      step("lich up exit 0");

      // dev:fast sentinel: api /health should report db: stub (profile drift guard)
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
      step("api /health reports db: stub");
    },
    60_000,
  );

  it(
    "writes daemon.pid + daemon.url and dashboard /healthz returns 200",
    async () => {
      expect(lichHome, "lichHome — setup it must have run").not.toBeNull();
      expect(stackPath, "stackPath — setup it must have run").not.toBeNull();

      step("waiting for daemon pid + url files");
      const { pid, url } = await waitForDaemonRunning(lichHome!, {
        timeoutMs: 30_000,
      });
      expect(pid).toBeGreaterThan(0);
      // daemon binds 127.0.0.1 only (local-only tool)
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      step(`daemon alive: pid=${pid} url=${url}`);

      expect(readDaemonUrl(lichHome!)).toBe(url);

      step(`probing dashboard /healthz (${url}/healthz)`);
      const healthRes = await fetch(`${url}/healthz`);
      expect(healthRes.status).toBe(200);
      step("dashboard /healthz 200 OK");
    },
    30_000,
  );

  it(
    "(teardown) lich down + daemon auto-stops (or nuke as fallback)",
    async () => {
      if (!stackPath || !lichHome) return;

      step("lich down");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");

      step("waiting for daemon auto-shutdown (~30s by design)");
      let autoStopped = false;
      try {
        await waitForDaemonStopped(lichHome, { timeoutMs: 60_000 });
        autoStopped = true;
        step("daemon stopped cleanly via auto-shutdown");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "daemon failed to auto-stop within 60s; falling back to nuke:",
          err,
        );
      }

      if (!autoStopped) {
        step("nuke fallback (auto-shutdown stalled)");
        const nukeResult = runLich(["nuke", "--yes"], {
          cwd: stackPath,
          env: { LICH_HOME: lichHome },
          timeout: 90_000,
        });
        if (nukeResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn("nuke fallback stdout:", nukeResult.stdout);
          // eslint-disable-next-line no-console
          console.warn("nuke fallback stderr:", nukeResult.stderr);
        }
        await waitForDaemonStopped(lichHome, { timeoutMs: 30_000 });
        step("daemon stopped via nuke fallback");
      }
    },
    180_000,
  );
});
