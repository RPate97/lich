/**
 * LEV-530: stale log content from a prior run must not satisfy ready_when.log_match
 * or trip fail_when.log_match on a subsequent `lich up`. The run-boundary marker
 * makes the segment visible in `lich logs` and matchers anchor past it.
 *
 * This complements failure-stale-log-fail-when.test.ts (LEV-512) by covering:
 *  1. ready_when.log_match immunity (LEV-512 only covered fail_when)
 *  2. A realistic "service emits sentinel on shutdown" path (no manual injection)
 *  3. Run-boundary marker visibility through `lich logs`
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-stale-ready-home-"));
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

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

// Service that emits "READY_GO_TIME" once at startup, then sleeps.
// On SIGTERM, its trap emits "ELIFECYCLE shutdown noise" — exactly the kind of
// stale line that LEV-530 reports tripping `fail_when` on the next `up`.
const READY_AND_FAIL_YAML = `version: "1"

owned:
  svc:
    cmd: |
      trap 'echo "ELIFECYCLE shutdown noise"; exit 0' TERM INT
      echo "starting up..."
      sleep 0.2
      echo "READY_GO_TIME server bound"
      while true; do sleep 0.1; done
    ready_when:
      log_match: "READY_GO_TIME"
      timeout: "10s"
    fail_when:
      log_match: "ELIFECYCLE"

profiles:
  dev:
    default: true
    owned: [svc]
`;

describe("lich up — ready_when + fail_when stale log immunity (LEV-530)", () => {
  it(
    "second up succeeds even though prior run wrote both ready and fail sentinels",
    async () => {
      fixture = makeFixture(READY_AND_FAIL_YAML);
      const { stackPath, lichHome } = fixture;

      const up1 = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
      expect(
        up1.exitCode,
        `first lich up failed:\n${up1.stdout}\n${up1.stderr}`,
      ).toBe(0);

      // Down sends SIGTERM; the trap above writes "ELIFECYCLE shutdown noise"
      // to the service log file BEFORE the file handle is closed.
      const down = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(
        down.exitCode,
        `lich down failed:\n${down.stdout}\n${down.stderr}`,
      ).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId, "stack state dir must exist after first up/down").not.toBeNull();
      const logPath = join(lichHome, "stacks", stackId!, "logs", "svc.log");
      expect(existsSync(logPath), `log file must exist at ${logPath}`).toBe(true);

      // Sanity: the stale fail_when sentinel really is in the file before the second up.
      const beforeContents = readFileSync(logPath, "utf8");
      expect(
        beforeContents,
        "prior shutdown should have written the stale fail_when sentinel into the log",
      ).toContain("ELIFECYCLE shutdown noise");
      expect(
        beforeContents,
        "prior run's READY_GO_TIME line must also still be in the file",
      ).toContain("READY_GO_TIME");

      // Second up: must NOT trip fail_when on the stale ELIFECYCLE line, and must
      // wait for the NEW READY_GO_TIME (not immediately match the stale one).
      const up2 = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
      expect(
        up2.exitCode,
        `second lich up tripped on stale log content:\n${up2.stdout}\n${up2.stderr}`,
      ).toBe(0);

      // After the second up, the log must contain a run-boundary marker that
      // delineates the prior run's content from the current run's content.
      const afterContents = readFileSync(logPath, "utf8");
      const markerLines = afterContents
        .split("\n")
        .filter((line) => /^=== lich up at .+ \[run: .+\] ===$/u.test(line));
      expect(
        markerLines.length,
        `expected at least one run-boundary marker line in the log:\n${afterContents}`,
      ).toBeGreaterThanOrEqual(2);

      // `lich logs` must surface BOTH the historical sentinel AND the marker so a
      // user investigating a prior failure can still see what the dead run did.
      const logsResult = runLich(["logs", "svc", "--no-follow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 5_000,
      });
      expect(logsResult.exitCode).toBe(0);
      expect(logsResult.stdout).toContain("ELIFECYCLE shutdown noise");
      expect(logsResult.stdout).toContain("READY_GO_TIME");
      expect(logsResult.stdout).toMatch(/=== lich up at .+ \[run: .+\] ===/u);
    },
    90_000,
  );
});
