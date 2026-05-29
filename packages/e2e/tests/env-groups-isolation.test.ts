import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
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

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

describe("env_groups isolation", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-groups-iso-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Explicit "dev": test 2 needs DATABASE_URL with allocated postgres port
      const upResult = runLich(["up", "dev"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with env_group tests`,
        );
      }

      // Verify db: "live" — catches profile drift at setup time
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
      await expectDbMode(apiUrl!, "live");
    },
    300_000,
  );

  it("process_env: false blocks shell env passthrough", () => {
    const fix = fixture!;
    // LEAK_TEST is the canary; must not appear in isolated-tools (process_env: false)
    const result = runLich(["env", "isolated-tools"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome, LEAK_TEST: "from-shell" },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/^LEAK_TEST=/m);
    expect(result.stdout).not.toContain("from-shell");
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
  });

  it("extends: stack inherits stack env", () => {
    const fix = fixture!;
    const result = runLich(["env", "stack-plus-test"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^DATABASE_URL=postgresql:\/\/postgres:postgres@localhost:\d+\/dogfood$/m,
    );
    expect(result.stdout).toMatch(/^TEST_MODE=integration$/m);
  });

  it("user group without extends does NOT include stack env", () => {
    const fix = fixture!;
    const result = runLich(["env", "isolated-tools"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // isolated-tools has no `extends` → stack pipeline doesn't run
    expect(result.stdout).not.toMatch(/^DATABASE_URL=/m);
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 120_000,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown lich nuke failed:", err);
      }
      try {
        fixture.stackCleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown tmpdir cleanup failed:", err);
      }
      try {
        rmSync(fixture.lichHome, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    180_000,
  );
});
