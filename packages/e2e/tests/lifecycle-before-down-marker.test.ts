import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

describe("dogfood-stack lifecycle.before_down (LEV-473)", () => {
  it(
    "before_down hook writes teardown marker with env_group + top-level env values",
    () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      // Defensive: cpSync should preserve mode but a future helper change
      // shouldn't break this test with EACCES. Mirrors the same belt-and-
      // suspenders pattern in lifecycle-env-group.test.ts.
      chmodSync(join(stack.path, "scripts/teardown-marker.sh"), 0o755);
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-before-down-marker-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Default profile (dev:fast) keeps this test in the fast pool —
      // no docker, no postgres. The before_down hook still runs because
      // top-level lifecycle entries fire for every profile.
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

      // Marker MUST NOT exist before `lich down` — the hook fires only
      // during teardown, not at `up` time.
      const markerPath = join(home, "teardown-marker.txt");
      expect(
        existsSync(markerPath),
        `teardown marker should not exist before lich down (got ${markerPath})`,
      ).toBe(false);

      const downResult = runLich(["down"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 30_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:\n" + downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:\n" + downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);

      // Primary observable: the hook fired and produced the marker file.
      expect(
        existsSync(markerPath),
        `expected before_down marker at ${markerPath}`,
      ).toBe(true);

      const marker = readFileSync(markerPath, "utf8");

      // TEST_MODE comes from the `stack-plus-test` env_group literal.
      // Proves the env_group resolved and reached before_down — direct
      // mirror of the after_up + env_group coverage.
      expect(
        marker,
        `marker should contain TEST_MODE=integration; got:\n${marker}`,
      ).toContain("TEST_MODE=integration");

      // LICH_WORKTREE is auto-injected into the stack env (env/resolve.ts).
      // The env_group `stack-plus-test extends: stack`, so the var must
      // flow through. Empty value would mean the stack env didn't merge.
      expect(
        marker,
        `marker should carry a non-empty LICH_WORKTREE; got:\n${marker}`,
      ).toMatch(/^LICH_WORKTREE=.+$/m);

      // API_URL is the top-level `env:` entry. Pre-LEV-485 the down-side
      // hook was spawned with `env: process.env` and this would resolve
      // empty. Asserting on the actual interpolated URL (with a port)
      // proves both env propagation AND port-aware interpolation reach
      // before_down.
      expect(
        marker,
        `marker should carry API_URL with a numeric port; got:\n${marker}`,
      ).toMatch(/^API_URL=http:\/\/localhost:\d+$/m);

      // FAKE_SECRET_TOKEN is the top-level `env_from:` value (loaded via
      // ./scripts/fake-secrets.sh). Pre-LEV-485 this would also be empty.
      // Pinning the exact value catches env_from regressions on the down
      // path specifically (a sibling assertion in env-from-fake-secrets
      // covers up-path).
      expect(
        marker,
        `marker should carry FAKE_SECRET_TOKEN=abc123; got:\n${marker}`,
      ).toContain("FAKE_SECRET_TOKEN=abc123");
    },
    120_000,
  );
});
