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

describe("top-level env_from (fake-secrets.sh)", () => {
  it(
    "scripts/fake-secrets.sh output flows into the resolved stack env",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      // cpSync should preserve mode but be defensive — a future helper change
      // that drops the exec bit would surface as ShellOutError instead of
      // "secrets missing", which is harder to diagnose. Mirrors the same
      // pattern in lifecycle-env-group.test.ts for write-marker.sh.
      chmodSync(join(stack.path, "scripts/fake-secrets.sh"), 0o755);
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-fake-secrets-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Default profile is dev:fast (no postgres) — env_from runs at env
      // resolution regardless of profile, and dev:fast keeps this test in
      // the fast pool. `lich up` is needed because the top-level env
      // contains `${owned.api.port}` interpolation, which can't resolve
      // without allocated ports recorded in state.json.
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

      // Primary observable: `lich exec` exposes the env_from values to a
      // spawned child. Mirrors the documented "secrets reach a running
      // service" contract — exec uses the same env_group=stack resolution
      // that an owned service would inherit. Leading `--` keeps mri from
      // eating sh's `-c` flag (same convention as exec.test.ts).
      const probe = runLich(
        [
          "exec",
          "--",
          "sh",
          "-c",
          "echo $FAKE_SECRET_TOKEN,$FAKE_SECRET_REGION",
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
      expect(probe.stdout.trim()).toBe("abc123,us-east-1");

      // Sanity sibling: `lich env stack` emits both keys on their own lines.
      // Catches a future regression where exec sees them but the dotenv
      // serializer drops them (e.g., a sort/quote bug specific to env_from
      // keys).
      const envOut = runLich(["env", "stack"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      expect(envOut.exitCode).toBe(0);
      expect(envOut.stdout).toMatch(/^FAKE_SECRET_TOKEN=abc123$/m);
      expect(envOut.stdout).toMatch(/^FAKE_SECRET_REGION=us-east-1$/m);
    },
    120_000,
  );
});
