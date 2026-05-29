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

describe("user-defined command invocation", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-commands-user-defined-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      const upResult = runLich(["up", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with ` +
            `user-command dispatch tests`,
        );
      }

      // Verify dev:fast's `db: "stub"` contract; catches silent profile drift.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
    },
    120_000,
  );

  it("lich <user-command> runs the cmd with resolved env", () => {
    const fix = fixture!;
    const result = runLich(["test:e2e"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich test:e2e stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich test:e2e stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no e2e tests in dogfood-stack yet");
  });

  it("extra argv is forwarded to the underlying cmd", () => {
    const fix = fixture!;
    // BSD printenv ignores extra positionals; exit 0 proves the dispatcher
    // accepted them rather than rejecting as usage error.
    const result = runLich(["tools:env-check", "--extra", "foo"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich tools:env-check stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich tools:env-check stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("standalone");

    // Leading `--` prevents mri from eating `-c`; trailing `--` is sh's `$0`
    // slot so `"$@"` covers a/b/c (sh assigns first positional after `-c` to $0).
    const argv = ["exec", "--", "sh", "-c", 'echo "$@"', "--", "a", "b", "c"];
    const exec = runLich(argv, {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (exec.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", exec.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", exec.stderr);
    }
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim()).toBe("a b c");
  });

  it("unknown command emits exit 2 with 'unknown command' on stderr", () => {
    const fix = fixture!;
    const result = runLich(["does:not:exist"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("does:not:exist");
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
