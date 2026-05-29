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
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
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
    join(tmpdir(), "lich-e2e-failure-cascade-kill-home-"),
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 8s headroom for SIGTERM (5s) + SIGKILL + kernel reap
async function waitForPidDead(
  pid: number,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// exiter fails immediately; long_a/long_b would sleep forever without cascade.
// long_a/long_b reach `ready` first so the cascade tears down ready siblings.
const DEFAULT_ON_YAML = `version: "1"

owned:
  exiter:
    cmd: 'exit 1'
  long_a:
    cmd: 'echo "READY_A"; sleep 60'
    ready_when:
      log_match: "READY_A"
  long_b:
    cmd: 'echo "READY_B"; sleep 60'
    ready_when:
      log_match: "READY_B"

profiles:
  dev:
    default: true
    owned: [exiter, long_a, long_b]
`;

const OPT_OUT_YAML = `version: "1"

runtime:
  kill_others_on_fail: false

owned:
  exiter:
    cmd: 'exit 1'
  long_a:
    cmd: 'echo "READY_A"; sleep 60'
    ready_when:
      log_match: "READY_A"
  long_b:
    cmd: 'echo "READY_B"; sleep 60'
    ready_when:
      log_match: "READY_B"

profiles:
  dev:
    default: true
    owned: [exiter, long_a, long_b]
`;

describe("lich up — runtime.kill_others_on_fail", () => {
  it(
    "cascade-kills sibling owned services when one fails the startup race (default ON)",
    async () => {
      fixture = makeFixture(DEFAULT_ON_YAML);
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
      const elapsedMs = Date.now() - t0;

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected success — stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected success — stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);

      // Load-bearing timing: <15s = cascade fired. >60s = stuck on sleep.
      expect(
        elapsedMs,
        `lich up took ${elapsedMs}ms; cascade should land in <15s (5s grace + ` +
          `orchestrator overhead). If this is near 60s the cascade didn't fire ` +
          `and the siblings' sleep 60 is blocking the test.`,
      ).toBeLessThan(15_000);

      const stackId = findStackId(lichHome);
      expect(
        stackId,
        `no stack dir under ${lichHome}/stacks/ — state.json was never written`,
      ).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const longASnap = snap.services.find((s) => s.name === "long_a");
      const longBSnap = snap.services.find((s) => s.name === "long_b");
      expect(longASnap, "long_a missing from state.json").toBeDefined();
      expect(longBSnap, "long_b missing from state.json").toBeDefined();
      expect(longASnap!.pid, "long_a has no pid in state.json").toBeDefined();
      expect(longBSnap!.pid, "long_b has no pid in state.json").toBeDefined();

      const longAReaped = await waitForPidDead(longASnap!.pid!);
      const longBReaped = await waitForPidDead(longBSnap!.pid!);
      expect(
        longAReaped,
        `long_a pid ${longASnap!.pid} survived past lich up — cascade-kill did NOT fire`,
      ).toBe(true);
      expect(
        longBReaped,
        `long_b pid ${longBSnap!.pid} survived past lich up — cascade-kill did NOT fire`,
      ).toBe(true);

      const combined = upResult.stdout + "\n" + upResult.stderr;
      expect(combined).toContain("killed:");
      expect(combined).toContain("long_a");
      expect(combined).toContain("long_b");
    },
    60_000,
  );

  it(
    "leaves sibling services running when runtime.kill_others_on_fail is false (opt-out)",
    async () => {
      fixture = makeFixture(OPT_OUT_YAML);
      const { stackPath, lichHome } = fixture;

      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      if (validateResult.exitCode !== 0) {
        throw new Error(
          `opt-out yaml failed validate — runtime.kill_others_on_fail ` +
            `schema regression or stale binary.\n` +
            `--- validate stdout ---\n${validateResult.stdout}\n` +
            `--- validate stderr ---\n${validateResult.stderr}`,
        );
      }

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });

      expect(upResult.exitCode).not.toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const longASnap = snap.services.find((s) => s.name === "long_a");
      const longBSnap = snap.services.find((s) => s.name === "long_b");
      expect(longASnap!.pid).toBeDefined();
      expect(longBSnap!.pid).toBeDefined();

      expect(
        isPidAlive(longASnap!.pid!),
        `long_a pid ${longASnap!.pid} is dead — kill_others_on_fail: false should ` +
          `have LEFT it alive (legacy behavior)`,
      ).toBe(true);
      expect(
        isPidAlive(longBSnap!.pid!),
        `long_b pid ${longBSnap!.pid} is dead — kill_others_on_fail: false should ` +
          `have LEFT it alive (legacy behavior)`,
      ).toBe(true);

      const combined = upResult.stdout + "\n" + upResult.stderr;
      expect(combined).not.toContain("killed:");

      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });
      expect(downResult.exitCode).toBe(0);
      const longAReaped = await waitForPidDead(longASnap!.pid!);
      const longBReaped = await waitForPidDead(longBSnap!.pid!);
      expect(
        longAReaped,
        `long_a pid ${longASnap!.pid} survived past lich down — down regressed`,
      ).toBe(true);
      expect(
        longBReaped,
        `long_b pid ${longBSnap!.pid} survived past lich down — down regressed`,
      ).toBe(true);
    },
    60_000,
  );
});

describe("lich up — oneshot stop_cmd on cascade-kill", () => {
  // Verifies LEV-511: stop_cmd fires on every teardown path, not just clean `lich down`.
  // Uses a sentinel file created by stop_cmd to prove it ran.

  it(
    "invokes oneshot stop_cmd when after_up fails (cascade-kill teardown)",
    async () => {
      const sentinelDir = mkdtempSync(join(tmpdir(), "lich-e2e-stop-cmd-sentinel-"));
      const sentinelFile = join(sentinelDir, "stop_cmd_ran");

      const yaml = `version: "1"

owned:
  sidecar:
    oneshot: true
    cmd: 'true'
    stop_cmd: 'touch ${sentinelFile}'

lifecycle:
  after_up:
    - cmd: 'false'

profiles:
  dev:
    default: true
    owned: [sidecar]
`;

      fixture = makeFixture(yaml);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });

      expect(upResult.exitCode).not.toBe(0);

      // Wait for the sentinel file — stop_cmd may still be running when lich up returns.
      const deadline = Date.now() + 5_000;
      while (!existsSync(sentinelFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(
        existsSync(sentinelFile),
        `stop_cmd sentinel file was not created — stop_cmd did not run on after_up failure teardown\n` +
          `lich up stdout:\n${upResult.stdout}\n` +
          `lich up stderr:\n${upResult.stderr}`,
      ).toBe(true);

      rmSync(sentinelDir, { recursive: true, force: true });
    },
    30_000,
  );

  it(
    "invokes oneshot stop_cmd when a sibling service fails the startup race",
    async () => {
      const sentinelDir = mkdtempSync(join(tmpdir(), "lich-e2e-stop-cmd-sentinel-"));
      const sentinelFile = join(sentinelDir, "stop_cmd_ran");

      const yaml = `version: "1"

owned:
  sidecar:
    oneshot: true
    cmd: 'true'
    stop_cmd: 'touch ${sentinelFile}'
  exiter:
    cmd: 'exit 1'

profiles:
  dev:
    default: true
    owned: [sidecar, exiter]
`;

      fixture = makeFixture(yaml);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });

      expect(upResult.exitCode).not.toBe(0);

      const deadline = Date.now() + 5_000;
      while (!existsSync(sentinelFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(
        existsSync(sentinelFile),
        `stop_cmd sentinel file was not created — stop_cmd did not run on sibling failure cascade\n` +
          `lich up stdout:\n${upResult.stdout}\n` +
          `lich up stderr:\n${upResult.stderr}`,
      ).toBe(true);

      rmSync(sentinelDir, { recursive: true, force: true });
    },
    30_000,
  );
});
