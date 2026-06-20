import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { sweepStaleLichResources } from "../helpers/heavy-pool-cleanup.js";
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
  // Clear any docker compose containers a previous heavy test left half-down
  // — without this, `lich up` here can hit a port 5432 conflict from a
  // stale postgres container that's mid-teardown, exit non-zero in ~8s.
  sweepStaleLichResources();
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  // Defensive: cpSync should preserve mode but a future helper change shouldn't EACCES
  chmodSync(join(stack.path, "scripts/write-marker.sh"), 0o755);
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-lifecycle-envgrp-home-"));
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

describe("lifecycle.after_up env_group resolution", () => {
  it(
    "after_up lifecycle entry uses env_group when specified",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up dev (runs after_up hook under stack-plus-test group)");
      const upResult = runLich(["up", "dev"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0 — after_up hook completed");

      // Verify db: "live" — catches profile drift
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
      await expectDbMode(apiUrl!, "live");

      const markerPath = join(lichHome, "marker.txt");
      expect(
        existsSync(markerPath),
        `expected marker file at ${markerPath} — after_up hook did not run or wrote to the wrong path`,
      ).toBe(true);

      const marker = readFileSync(markerPath, "utf8");
      step(`marker.txt:\n${marker.replace(/^/gm, "    ")}`);

      // TEST_MODE is only in the group's literal — proves group env reached executor
      expect(marker).toContain("TEST_MODE=integration");

      // digits prove port allocation flowed through; literal `${...}` token would fail
      expect(marker).toMatch(
        /DATABASE_URL=postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/dogfood/,
      );

      step("lich down (teardown)");
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
    },
    300_000,
  );
});
