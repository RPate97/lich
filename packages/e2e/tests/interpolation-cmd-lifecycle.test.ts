import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

let fixture: Fixture | null = null;

afterEach(() => {
  if (!fixture) return;
  try {
    runLich(["nuke", "--yes"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 60_000,
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
});

describe("LEV-514: ${...} interpolation reaches cmd: fields at runtime", () => {
  it(
    "lifecycle.after_ready cmd resolves ${owned.api.port} directly (no env mirror)",
    () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-interp-lifecycle-home-"),
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
        console.error("lich up stdout:\n" + upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:\n" + upResult.stderr);
      }
      expect(
        upResult.exitCode,
        `lich up should succeed; stderr was:\n${upResult.stderr}`,
      ).toBe(0);

      // The api after_ready hook writes api-port-direct.log via a cmd: that
      // contains ${owned.api.port} literally — no env: mirror in between.
      // If interpolation didn't fire, the literal token would appear instead
      // of a number, and printf would write e.g. "api_port=${owned.api.port}".
      const logPath = join(home, "api-port-direct.log");
      expect(
        existsSync(logPath),
        `expected api-port-direct.log at ${logPath} (hook did not run)`,
      ).toBe(true);

      const contents = readFileSync(logPath, "utf8");
      expect(
        contents,
        `api-port-direct.log should have api_port=<number>; got:\n${contents}`,
      ).toMatch(/^api_port=\d+$/m);
    },
    120_000,
  );

  it(
    "commands.show:api-port cmd resolves ${owned.api.port} directly (no env mirror)",
    () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-interp-cmd-home-"),
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
        console.error("lich up stdout:\n" + upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:\n" + upResult.stderr);
      }
      expect(
        upResult.exitCode,
        `lich up should succeed; stderr was:\n${upResult.stderr}`,
      ).toBe(0);

      // show:api-port prints `api_port=<N>` where <N> is resolved from
      // ${owned.api.port} at dispatch time — no env: mirror needed.
      const result = runLich(["show:api-port"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich show:api-port stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich show:api-port stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(
        result.stdout,
        `output should contain api_port=<number>; got:\n${result.stdout}`,
      ).toMatch(/api_port=\d+/);
    },
    120_000,
  );
});
