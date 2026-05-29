/**
 * LEV-512: stale log content from a prior run must not trigger fail_when.log_match
 * on the second `lich up`.
 *
 * Repro: up → down → inject stale sentinel into the service log → up again.
 * Without the fix, the second up immediately trips on the stale sentinel.
 * With the fix (LogTail startOffset), prior-run bytes are invisible to fail_when.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
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

function makeFixture(yaml: string): Fixture {
  const stack = copyFixtureToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-stale-log-home-"));
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
    console.warn(
      `afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`,
      err,
    );
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

// Service that starts clean (no fail_when sentinel in its normal output).
// The sentinel will be injected into the log AFTER `lich down` to simulate
// what a SIGTERM'd process writes on shutdown.
const STALE_LOG_YAML = `version: "1"

owned:
  svc:
    cmd: 'echo "starting"; echo "listening on 9999"; sleep 99999'
    ready_when:
      log_match: "listening on 9999"
      timeout: "10s"
    fail_when:
      log_match: "STALE_FAIL_SENTINEL"

profiles:
  dev:
    default: true
    owned: [svc]
`;

describe("lich up — fail_when stale log immunity (LEV-512)", () => {
  it(
    "second up ignores fail_when sentinel written by prior-run shutdown",
    async () => {
      fixture = makeFixture(STALE_LOG_YAML);
      const { stackPath, lichHome } = fixture;

      // First up — should succeed cleanly.
      const up1 = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
      expect(
        up1.exitCode,
        `first lich up failed:\n${up1.stdout}\n${up1.stderr}`,
      ).toBe(0);

      // Down — tears down the service; its log file persists.
      const down = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(
        down.exitCode,
        `lich down failed:\n${down.stdout}\n${down.stderr}`,
      ).toBe(0);

      // Inject stale sentinel into the service's log file — simulates what
      // a SIGTERM'd process (e.g. nodemon) writes during shutdown.
      const stackId = findStackId(lichHome);
      expect(stackId, "stack state dir must exist after first up/down").not.toBeNull();
      const logPath = join(lichHome, "stacks", stackId!, "logs", "svc.log");
      expect(existsSync(logPath), `log file must exist at ${logPath}`).toBe(true);
      appendFileSync(logPath, "STALE_FAIL_SENTINEL injected by prior shutdown\n");

      // Second up — must succeed despite stale sentinel in log.
      const up2 = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
      expect(
        up2.exitCode,
        `second lich up tripped on stale log content:\n${up2.stdout}\n${up2.stderr}`,
      ).toBe(0);

      // Historical content (including sentinel) must still be visible via `lich logs`.
      const logsResult = runLich(["logs", "svc", "--no-follow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 5_000,
      });
      expect(logsResult.exitCode).toBe(0);
      expect(logsResult.stdout).toContain("STALE_FAIL_SENTINEL");
    },
    90_000,
  );
});
