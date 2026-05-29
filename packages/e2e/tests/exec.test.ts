import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  if (existsSync(LICH_BINARY)) return;
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
  if (!existsSync(LICH_BINARY)) {
    throw new Error(
      `lich build reported success but ${LICH_BINARY} does not exist`,
    );
  }
});

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

describe("lich exec", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-exec-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Explicit "dev" — exec test 1 needs DATABASE_URL with allocated postgres port
      const upResult = runLich(["up", "dev", "--no-browser"], {
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
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with exec tests`,
        );
      }
    },
    300_000,
  );

  it("runs an arbitrary command with the stack env", () => {
    const fix = fixture!;
    // Leading `--` keeps mri from eating sh's `-c` flag.
    const result = runLich(
      ["exec", "--", "sh", "-c", "echo $DATABASE_URL"],
      {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
      },
    );
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /postgresql:\/\/postgres:postgres@localhost:\d+\/dogfood/,
    );
  });

  it("--env-group=<X> overrides the default stack group", () => {
    const fix = fixture!;
    const result = runLich(
      [
        "exec",
        "--env-group=isolated-tools",
        "--",
        "sh",
        "-c",
        "echo $TOOL_MODE-$DATABASE_URL",
      ],
      {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
      },
    );
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // isolated-tools has no `extends` → DATABASE_URL unset → echo prints "standalone-"
    expect(result.stdout.trim()).toBe("standalone-");
  });

  it("exits 2 with usage when no command argv given", () => {
    const fix = fixture!;
    const result = runLich(["exec"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toLowerCase()).toContain("usage");
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        spawnSync(LICH_BINARY, ["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { ...process.env, LICH_HOME: fixture.lichHome },
          timeout: 90_000,
          encoding: "utf8",
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
        if (existsSync(fixture.lichHome)) {
          rmSync(fixture.lichHome, { recursive: true, force: true });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    180_000,
  );
});
