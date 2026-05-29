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

// ---------------------------------------------------------------------------
// Per-test fixture state — every test gets a fresh tmpdir / LICH_HOME so
// nothing leaks between tests and the user's real ~/.lich is never touched.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

/**
 * Build a fresh fixture: a tmpdir copy of the dogfood-stack with its
 * `lich.yaml` overwritten by `yaml`. The original `apps/` / `db/`
 * children are untouched — they're unreferenced by the replacement yaml,
 * just inert siblings.
 */
function makeFixture(yaml: string): Fixture {
  // install: false — the replacement yaml runs a `sh -c 'echo …; sleep …'`
  // command that doesn't depend on any locally-installed binary, so we
  // skip the (slow) bun install in the tmpdir.
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-failure-fail-when-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Always-best-effort teardown. `lich down` shuts down any lingering owned
 * services (the `sleep 99999` in our replacement yaml is what we mostly
 * care about cleaning up); then the tmpdir + LICH_HOME are removed.
 *
 * Note: when `lich up` returns exit 1 for a per-level failure, the
 * orchestrator does NOT proactively tear down services that started
 * successfully in earlier levels (see up.ts:872-887). The minimal yaml
 * here puts the bad service in the only level, so on failure there's
 * nothing else to clean up — but `lich down` is idempotent and harmless,
 * so we always call it.
 */
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

// ready_when with never-matching pattern is required: waitReady short-circuits
// without ready_when and the fail_when watcher never gets wired in.
// EADDRINUSE pattern is one of formatFailure's known patterns → synthesized hint.
const FAIL_WHEN_YAML = `version: "1"

owned:
  bad:
    cmd: 'echo "starting"; echo "EADDRINUSE somewhere"; sleep 99999'
    ready_when:
      log_match: "READY_NEVER_MATCHES"
      timeout: "30s"
    fail_when:
      log_match: "EADDRINUSE"

profiles:
  dev:
    default: true
    owned: [bad]
`;

describe("lich up — fail_when.log_match", () => {
  it(
    "aborts within seconds, surfaces the failure block + hint, persists failure to state.json",
    async () => {
      fixture = makeFixture(FAIL_WHEN_YAML);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      const combined = upResult.stdout + "\n" + upResult.stderr;

      expect(combined).toContain('service "bad"');
      expect(combined).toContain("matched fail_when pattern");
      expect(combined).toContain("EADDRINUSE somewhere");
      expect(combined).toContain(
        "run `lich stacks` to find what's using the port",
      );

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const bad = snap.services.find((s) => s.name === "bad");
      expect(bad, `expected 'bad' service in state.json: ${JSON.stringify(snap.services)}`)
        .toBeDefined();
      expect(bad!.state).toBe("failed");

      expect(bad!.failure_reason).toBeDefined();
      expect(bad!.failure_reason).toContain("EADDRINUSE");

      expect(bad!.failure_log_tail).toBeDefined();
      expect(bad!.failure_log_tail!.length).toBeGreaterThan(0);
      expect(
        bad!.failure_log_tail!.some((line) => line.includes("EADDRINUSE")),
        `expected failure_log_tail to include the matched line, got: ${JSON.stringify(bad!.failure_log_tail)}`,
      ).toBe(true);

      const logsResult = runLich(["logs", "bad", "--no-follow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 5_000,
      });
      expect(logsResult.exitCode).toBe(0);
      expect(logsResult.stdout).toContain("starting");
      expect(logsResult.stdout).toContain("EADDRINUSE somewhere");
    },
    60_000,
  );
});
