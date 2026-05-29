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
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
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

function makeFixture(): Fixture {
  const stack = copyFixtureToTmpdir("three-service-stack");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-restart-ps-home-"));
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
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try { fix.stackCleanup(); } catch { /* best-effort */ }
  try { rmSync(fix.lichHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const { readdirSync, statSync: ss } = require("node:fs");
  const entries: string[] = readdirSync(stacksRoot).filter((name: string) => {
    try { return ss(join(stacksRoot, name)).isDirectory(); } catch { return false; }
  });
  return entries[0] ?? null;
}

describe("lich restart <service> — per-service restart", () => {
  it(
    "restarts only the named middle service; sibling PIDs are unchanged",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        process.stderr.write(`lich up stdout: ${upResult.stdout}\n`);
        process.stderr.write(`lich up stderr: ${upResult.stderr}\n`);
      }
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snapBefore = await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 10_000 });
      expect(snapBefore.status).toBe("up");

      const svcs = ["svc-a", "svc-b", "svc-c"];
      for (const name of svcs) {
        const svc = snapBefore.services.find((s) => s.name === name);
        expect(svc?.state, `${name} should be ready before restart`).toBe("ready");
      }

      const pidsBefore = new Map<string, number>();
      for (const svc of snapBefore.services) {
        if (typeof svc.pid === "number") pidsBefore.set(svc.name, svc.pid);
      }
      expect(pidsBefore.size).toBe(3);

      // Restart only svc-b (the middle service).
      const restartResult = runLich(["restart", "svc-b"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (restartResult.exitCode !== 0) {
        process.stderr.write(`lich restart stdout: ${restartResult.stdout}\n`);
        process.stderr.write(`lich restart stderr: ${restartResult.stderr}\n`);
      }
      expect(restartResult.exitCode).toBe(0);

      // Poll until state.json is flushed after restart.
      const snapAfter = await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 15_000 });

      const svcAAfter = snapAfter.services.find((s) => s.name === "svc-a");
      const svcBAfter = snapAfter.services.find((s) => s.name === "svc-b");
      const svcCAfter = snapAfter.services.find((s) => s.name === "svc-c");

      // svc-b was restarted — pid must differ.
      expect(svcBAfter?.pid, "svc-b should have a new pid after restart").not.toBe(pidsBefore.get("svc-b"));

      // svc-a and svc-c were NOT touched — pids must be identical.
      expect(svcAAfter?.pid, "svc-a pid should be unchanged").toBe(pidsBefore.get("svc-a"));
      expect(svcCAfter?.pid, "svc-c pid should be unchanged").toBe(pidsBefore.get("svc-c"));

      // All three services must still be in "ready" state.
      for (const name of svcs) {
        const svc = snapAfter.services.find((s) => s.name === name);
        expect(svc?.state, `${name} should be ready after restart`).toBe("ready");
      }
    },
    120_000,
  );

  it(
    "whole-stack restart still works (no services arg)",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 10_000 });

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (restartResult.exitCode !== 0) {
        process.stderr.write(`lich restart stdout: ${restartResult.stdout}\n`);
        process.stderr.write(`lich restart stderr: ${restartResult.stderr}\n`);
      }
      expect(restartResult.exitCode).toBe(0);

      const snapAfter = await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 15_000 });
      expect(snapAfter.status).toBe("up");
      for (const svc of snapAfter.services) {
        expect(svc.state, `${svc.name} should be ready`).toBe("ready");
      }
    },
    120_000,
  );

  it(
    "lich restart --all works as explicit whole-stack restart",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 10_000 });

      const restartResult = runLich(["restart", "--all"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode).toBe(0);

      const snapAfter = await waitForStackStatus(lichHome, stackId!, "up", { timeoutMs: 15_000 });
      expect(snapAfter.status).toBe("up");
    },
    120_000,
  );

  it(
    "errors on unknown service name",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(upResult.exitCode).toBe(0);

      await waitForStackStatus(lichHome, findStackId(lichHome)!, "up", { timeoutMs: 10_000 });

      const restartResult = runLich(["restart", "does-not-exist"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      expect(restartResult.exitCode).not.toBe(0);
      expect(restartResult.stdout + restartResult.stderr).toContain("does-not-exist");
    },
    120_000,
  );
});
