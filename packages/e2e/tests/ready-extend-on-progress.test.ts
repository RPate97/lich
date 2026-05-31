/**
 * LEV-535: `ready_when.extend_on_progress` reinterprets `timeout` as
 * "max acceptable silence between log lines" instead of a wall-clock deadline.
 *
 * Two complementary scenarios — both run end-to-end against the real binary:
 *  1. A service that takes 5s to ready but emits a line every 1s with
 *     `timeout: 2s` MUST succeed (each line resets the silence deadline).
 *  2. A service that goes silent for 5s with `timeout: 2s` MUST fail (the
 *     silence-deadline still fires when output stops).
 *
 * Fast pool — no docker, single owned service per case.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { runLich } from "../helpers/lich.js";
import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
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

function makeFixture(yaml: string): Fixture {
  const stack = copyFixtureToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-extend-on-progress-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
    });
  } catch (err) {
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

// Service emits a progress line every 1s for 5 iterations, then the ready
// sentinel. With timeout: 2s and extend_on_progress: true, each progress
// line resets the silence deadline — total wait (~5s) exceeds the 2s budget
// but never sees 2s of silence.
const PROGRESS_OK_YAML = `version: "1"

profiles:
  dev:
    default: true
    owned: [progressor]

owned:
  progressor:
    cmd: |
      for i in 1 2 3 4 5; do
        echo "progress line $i"
        sleep 1
      done
      echo "READY_NOW"
      while true; do sleep 1; done
    ready_when:
      log_match: "READY_NOW"
      timeout: "2s"
      extend_on_progress: true
`;

// Service goes silent for 5s after a single progress line, then would emit
// READY_NOW. With timeout: 2s + extend_on_progress: true the silence-deadline
// must still fire because the service has been quiet for >2s.
const SILENT_FAIL_YAML = `version: "1"

profiles:
  dev:
    default: true
    owned: [silent]

owned:
  silent:
    cmd: |
      echo "starting up..."
      sleep 5
      echo "READY_NOW"
      while true; do sleep 1; done
    ready_when:
      log_match: "READY_NOW"
      timeout: "2s"
      extend_on_progress: true
`;

describe("lich up — ready_when.extend_on_progress (LEV-535)", () => {
  it(
    "succeeds when the service emits log lines faster than the silence deadline",
    () => {
      fixture = makeFixture(PROGRESS_OK_YAML);
      const { stackPath, lichHome } = fixture;

      const validate = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(
        validate.exitCode,
        `validate failed:\n${validate.stdout}\n${validate.stderr}`,
      ).toBe(0);

      const t0 = Date.now();
      const up = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsed = Date.now() - t0;

      expect(
        up.exitCode,
        `up failed despite progress lines arriving within the silence deadline:\n` +
          `--- stdout ---\n${up.stdout}\n--- stderr ---\n${up.stderr}`,
      ).toBe(0);

      // Wall-clock sanity: the script needs ~5s to emit READY_NOW. If we
      // somehow finished much faster the test isn't actually exercising the
      // progress-extension path (e.g. a regression that ignored the field
      // and a wider default that masked the bug).
      expect(
        elapsed,
        `up returned in ${elapsed}ms; expected ≥4s wall clock for the 5x1s loop`,
      ).toBeGreaterThan(4_000);
    },
    45_000,
  );

  it(
    "fails when the service goes silent for longer than the silence deadline",
    () => {
      fixture = makeFixture(SILENT_FAIL_YAML);
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const up = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsed = Date.now() - t0;

      expect(
        up.exitCode,
        `up unexpectedly succeeded despite 5s of silence and a 2s deadline:\n` +
          `--- stdout ---\n${up.stdout}\n--- stderr ---\n${up.stderr}`,
      ).not.toBe(0);

      // The 2s deadline + the "starting up..." line at t≈0 = silence-fail
      // at t≈2-3s. 20s ceiling gives generous slack for slow CI.
      expect(
        elapsed,
        `up took ${elapsed}ms; expected the 2s silence deadline to fire well within 20s`,
      ).toBeLessThan(20_000);

      const combined = up.stdout + up.stderr;
      // Formatter wording is shared with the wall-clock timeout path — the
      // user sees "within 2s" regardless of which path fired.
      expect(combined).toContain("within 2s");
      expect(combined).toContain("silent");
    },
    45_000,
  );
});
