import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
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

describe("show:version user command (LEV-475)", () => {
  it(
    "`lich show:version` prints env_from values + literal ENVIRONMENT via from-cmd-secrets env_group",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack");
      // Defensive chmod mirrors env-group-from-cmd-secrets.test.ts — a future
      // tmpdir helper change that drops the exec bit would surface here as
      // ShellOutError rather than missing values, which is harder to diagnose.
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-commands-show-version-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // No `lich up` needed: show:version uses the `from-cmd-secrets`
      // env_group, which doesn't extend `stack` and therefore needs no
      // allocated ports / interpolation. The dispatcher resolves the
      // env_group from yaml + env_from shell-out alone.
      const result = runLich(["show:version"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich show:version stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich show:version stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // env_from values from scripts/fake-secrets.sh
      expect(result.stdout).toContain("FAKE_SECRET_TOKEN=abc123");
      expect(result.stdout).toContain("region=us-east-1");
      // Literal `env:` inside the group also resolves alongside env_from.
      expect(result.stdout).toContain("env=ci");
    },
    60_000,
  );

  it(
    "`lich show:version` does not leak shell env (process_env: false on the group)",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack");
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-commands-show-version-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // FAKE_SECRET_TOKEN is set in the spawning shell; the group's
      // process_env:false must drop it so the value reaching the cmd comes
      // from env_from (abc123), not from the shell ("from-shell").
      const result = runLich(["show:version"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome, FAKE_SECRET_TOKEN: "from-shell" },
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("FAKE_SECRET_TOKEN=abc123");
      expect(result.stdout).not.toContain("from-shell");
    },
    60_000,
  );
});
