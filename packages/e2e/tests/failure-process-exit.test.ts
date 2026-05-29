import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForStackStatus } from "../helpers/state.js";
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
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-failure-process-exit-home-"),
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
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
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

const IMMEDIATE_EXIT_YAML = `version: "1"

owned:
  exiter:
    cmd: 'exit 1'

profiles:
  dev:
    default: true
    owned: [exiter]
`;

// sleep 0.5 gives LogTail's 100ms poll time to read the echo before exit;
// never-matching ready_when forces full race assembly (else 100ms probe wins).
const BRIEF_RUN_THEN_EXIT_YAML = `version: "1"

owned:
  exiter:
    cmd: 'echo "loading"; sleep 0.5; exit 2'
    ready_when:
      log_match: "READY_NEVER_MATCHES"
      timeout: "5s"

profiles:
  dev:
    default: true
    owned: [exiter]
`;

describe("lich up — process exits during startup", () => {
  it(
    "detects an immediate exit (cmd: 'exit 1'), surfaces the failure block with empty log tail, persists exit code to state.json",
    async () => {
      fixture = makeFixture(IMMEDIATE_EXIT_YAML);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      const combined = upResult.stdout + "\n" + upResult.stderr;

      expect(combined).toContain('service "exiter"');

      expect(combined).toContain("exited");
      expect(combined).toContain("code 1");

      const stackId = findStackId(lichHome);
      expect(
        stackId,
        `no stack dir under ${lichHome}/stacks/ — state.json was never written`,
      ).not.toBeNull();

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const exiter = snap.services.find((s) => s.name === "exiter");
      expect(
        exiter,
        `expected 'exiter' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(exiter!.state).toBe("failed");

      // ServiceSnapshot in state.ts doesn't enumerate failure fields
      const exiterWithFailure = exiter as typeof exiter & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };

      expect(
        exiterWithFailure.failure_reason,
        `exiter.failure_reason was not populated`,
      ).toBeDefined();
      expect(exiterWithFailure.failure_reason).toContain("code 1");

      expect(
        exiterWithFailure.failure_log_tail,
        `exiter.failure_log_tail must be present (possibly empty) for a failed service`,
      ).toBeDefined();
      expect(Array.isArray(exiterWithFailure.failure_log_tail)).toBe(true);
    },
    60_000,
  );

  it(
    "detects a brief-run-then-exit (cmd emits a line, sleeps, then exits 2), captures the line in failure_log_tail, fails fast",
    async () => {
      fixture = makeFixture(BRIEF_RUN_THEN_EXIT_YAML);
      const { stackPath, lichHome } = fixture;

      // Fail-fast timing sentinel: cmd exits at ~500ms, race should
      // short-circuit the 5s ready_when wait.
      const startMs = Date.now();
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      const elapsedMs = Date.now() - startMs;

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      // 3000ms budget = ~500ms cmd + overhead. Pre-fix this landed at 5s.
      expect(
        elapsedMs,
        `fail-fast regression: lich up took ${elapsedMs}ms for a service that ` +
          `exited at ~500ms with a 5s ready_when timeout. The race should ` +
          `short-circuit the wait at the exit, not wait for the timeout.`,
      ).toBeLessThan(3_000);

      const combined = upResult.stdout + "\n" + upResult.stderr;

      expect(combined).toContain('service "exiter"');

      // Exit code 2 (not 1) catches regressions that hardcode 1
      expect(combined).toContain("exited");
      expect(combined).toContain("code 2");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const exiter = snap.services.find((s) => s.name === "exiter");
      expect(
        exiter,
        `expected 'exiter' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(exiter!.state).toBe("failed");

      const exiterWithFailure = exiter as typeof exiter & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };

      expect(exiterWithFailure.failure_reason).toBeDefined();
      expect(exiterWithFailure.failure_reason).toContain("code 2");

      expect(exiterWithFailure.failure_log_tail).toBeDefined();
      expect(Array.isArray(exiterWithFailure.failure_log_tail)).toBe(true);
      expect(exiterWithFailure.failure_log_tail!.length).toBeGreaterThan(0);
      expect(
        exiterWithFailure.failure_log_tail!.some((line) =>
          line.includes("loading"),
        ),
        `expected failure_log_tail to include "loading" line, got: ${JSON.stringify(exiterWithFailure.failure_log_tail)}`,
      ).toBe(true);
    },
    60_000,
  );
});
