import { beforeAll, describe, expect, it } from "vitest";
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

function teardownFixture(fix: Fixture | null): void {
  if (!fix) return;
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 60_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown lich nuke failed:", err);
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown tmpdir cleanup failed:", err);
  }
  try {
    if (existsSync(fix.lichHome)) {
      rmSync(fix.lichHome, { recursive: true, force: true });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown LICH_HOME cleanup failed:", err);
  }
}

describe("env_files (.env) loads into stack env", () => {
  let fixture: Fixture | null = null;

  it(
    "values from .env reach lich exec via env_files",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-files-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      try {
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
        }
        expect(upResult.exitCode).toBe(0);

        const probe = runLich(
          [
            "exec",
            "--",
            "sh",
            "-c",
            "echo $LICH_DOGFOOD_EXAMPLE_FROM_DOTENV-$LICH_DOGFOOD_EXAMPLE_NUMERIC",
          ],
          {
            cwd: fixture.stackPath,
            env: { LICH_HOME: fixture.lichHome },
          },
        );
        if (probe.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich exec stdout:", probe.stdout);
          // eslint-disable-next-line no-console
          console.error("lich exec stderr:", probe.stderr);
        }
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.trim()).toBe("hello-from-dotenv-42");
      } finally {
        teardownFixture(fixture);
        fixture = null;
      }
    },
    120_000,
  );

  it(
    ".env.local overrides .env when both are present",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-files-local-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      try {
        writeFileSync(
          join(fixture.stackPath, ".env.local"),
          "LICH_DOGFOOD_EXAMPLE_FROM_DOTENV=overridden-by-local\n",
        );

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
        }
        expect(upResult.exitCode).toBe(0);

        const probe = runLich(
          [
            "exec",
            "--",
            "sh",
            "-c",
            "echo $LICH_DOGFOOD_EXAMPLE_FROM_DOTENV",
          ],
          {
            cwd: fixture.stackPath,
            env: { LICH_HOME: fixture.lichHome },
          },
        );
        if (probe.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich exec stdout:", probe.stdout);
          // eslint-disable-next-line no-console
          console.error("lich exec stderr:", probe.stderr);
        }
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.trim()).toBe("overridden-by-local");
      } finally {
        teardownFixture(fixture);
        fixture = null;
      }
    },
    120_000,
  );
});
