import {
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
  writeFileSync,
} from "node:fs";
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

describe("lich env <group>", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-dotenv-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Explicit "dev" profile: default flipped to dev:fast (no postgres);
      // this test needs DATABASE_URL with the allocated postgres host port.
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
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with env tests`,
        );
      }

      // Verify db: "live" (catches profile drift loudly at setup time).
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

  it("lich env stack prints dotenv with allocated-port values", () => {
    const fix = fixture!;
    const result = runLich(["env", "stack"], {
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
    // Digits in port slot prove allocated-port interpolation reached dotenv.
    expect(result.stdout).toMatch(
      /^DATABASE_URL=postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/dogfood$/m,
    );
    expect(result.stdout).toMatch(/^LICH_WORKTREE=/m);
    expect(result.stdout).toMatch(/^LICH_STACK_ID=/m);
  });

  it("lich env output is sourceable in bash", () => {
    const fix = fixture!;

    const envResult = runLich(["env", "stack"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(envResult.exitCode).toBe(0);

    const envFile = join(fix.lichHome, "stack.env");
    writeFileSync(envFile, envResult.stdout);

    // bash is the truth function for "is this dotenv well-formed?"
    const bashResult = spawnSync(
      "bash",
      ["-c", `set -a; source ${envFile}; set +a; echo "$DATABASE_URL"`],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (bashResult.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("bash stdout:", bashResult.stdout);
      // eslint-disable-next-line no-console
      console.error("bash stderr:", bashResult.stderr);
      // eslint-disable-next-line no-console
      console.error("env file contents:\n", envResult.stdout);
    }
    expect(bashResult.status).toBe(0);
    expect(bashResult.stdout).toMatch(
      /^postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/dogfood$/m,
    );
  });

  it("lich env <isolated-group> does not include stack vars", () => {
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
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
    // isolated-tools has no `extends`, so stack pipeline doesn't run
    expect(result.stdout).not.toMatch(/^DATABASE_URL=/m);
    expect(result.stdout).not.toMatch(/^LICH_STACK_ID=/m);
  });

  it("lich env <unknown> exits 1 with a helpful error", () => {
    const fix = fixture!;
    const result = runLich(["env", "does-not-exist"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("does-not-exist");
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
