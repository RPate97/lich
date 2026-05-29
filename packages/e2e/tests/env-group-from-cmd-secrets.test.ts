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

describe("env_group with env_from (from-cmd-secrets)", () => {
  it(
    "`lich env from-cmd-secrets` emits fake-secrets.sh values on their own dotenv lines",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack");
      // Defensive chmod in case a future copyExampleToTmpdir change drops mode
      // bits — mirrors env-from-fake-secrets.test.ts.
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-group-from-cmd-secrets-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // No `lich up` needed: this env_group doesn't extend `stack`, so it
      // doesn't depend on allocated ports / interpolation. `lich env` resolves
      // it from yaml + the env_from shell-out alone.
      const envOut = runLich(["env", "from-cmd-secrets"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      if (envOut.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich env stdout:", envOut.stdout);
        // eslint-disable-next-line no-console
        console.error("lich env stderr:", envOut.stderr);
      }
      expect(envOut.exitCode).toBe(0);
      expect(envOut.stdout).toMatch(/^FAKE_SECRET_TOKEN=abc123$/m);
      expect(envOut.stdout).toMatch(/^FAKE_SECRET_REGION=us-east-1$/m);
      // Literal `env:` inside the group also resolves alongside env_from.
      expect(envOut.stdout).toMatch(/^ENVIRONMENT=ci$/m);
    },
    60_000,
  );

  it(
    "process_env: false on the group blocks shell passthrough",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack");
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-group-from-cmd-secrets-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // LEAK_TEST is the canary — must not appear when process_env=false.
      const envOut = runLich(["env", "from-cmd-secrets"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome, LEAK_TEST: "from-shell" },
        timeout: 10_000,
      });
      expect(envOut.exitCode).toBe(0);
      expect(envOut.stdout).not.toMatch(/^LEAK_TEST=/m);
      expect(envOut.stdout).not.toContain("from-shell");
      // Sanity: the env_from values are still present in the same output.
      expect(envOut.stdout).toMatch(/^FAKE_SECRET_TOKEN=abc123$/m);
    },
    60_000,
  );

  it(
    "`lich exec --env-group=from-cmd-secrets` exposes env_from values to a child",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack");
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-group-from-cmd-secrets-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Mirrors exec.test.ts convention: leading `--` so mri doesn't eat
      // sh's `-c` flag. Proves the env_group resolution reaches a spawned
      // subprocess the same way it would reach a user-defined command.
      const probe = runLich(
        [
          "exec",
          "--env-group=from-cmd-secrets",
          "--",
          "sh",
          "-c",
          "echo $FAKE_SECRET_TOKEN,$FAKE_SECRET_REGION,$ENVIRONMENT",
        ],
        {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 10_000,
        },
      );
      if (probe.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich exec stdout:", probe.stdout);
        // eslint-disable-next-line no-console
        console.error("lich exec stderr:", probe.stderr);
      }
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.trim()).toBe("abc123,us-east-1,ci");
    },
    60_000,
  );
});
