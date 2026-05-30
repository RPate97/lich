import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
    join(tmpdir(), "lich-e2e-stacks-lifecycle-surfacing-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

afterEach(() => {
  if (!fixture) return;
  try {
    runLich(["down"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 30_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown lich down failed:`, err);
  }
  try {
    fixture.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown tmpdir cleanup failed:`, err);
  }
  try {
    rmSync(fixture.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown LICH_HOME cleanup failed:`, err);
  }
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

const AFTER_UP_FAIL_YAML = `version: "1"

owned:
  api:
    cmd: 'echo READY; sleep 60'
    ready_when:
      log_match: "READY"

lifecycle:
  after_up:
    - cmd: 'echo first-step-ran'
    - cmd: 'echo db-reset && false'
    - cmd: 'echo never-reached'

profiles:
  dev:
    default: true
    owned: [api]
`;

const CLEAN_YAML = `version: "1"

owned:
  api:
    cmd: 'echo READY; sleep 60'
    ready_when:
      log_match: "READY"

lifecycle:
  before_up:
    - cmd: 'echo before-up-ok'
  after_up:
    - cmd: 'echo after-up-ok'

profiles:
  dev:
    default: true
    owned: [api]
`;

describe("lich stacks — lifecycle hook surfacing (LEV-531)", () => {
  it(
    "table + JSON expose `after_up` failure with index, cmd, and log path",
    async () => {
      fixture = makeFixture(AFTER_UP_FAIL_YAML);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).not.toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId, `no stack dir under ${lichHome}/stacks/`).not.toBeNull();

      const tableResult = runLich(["stacks"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      expect(tableResult.exitCode).toBe(0);
      // Pre-LEV-531 bug: just `failed`. Post-fix: `failed (after_up 2/3: echo db-reset && false)`.
      expect(
        tableResult.stdout,
        `lich stacks table output should name the failed phase:\n${tableResult.stdout}`,
      ).toMatch(/failed \(after_up 2\/3: echo db-reset && false\)/);

      const jsonResult = runLich(["stacks", "--json"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      expect(jsonResult.exitCode).toBe(0);
      const parsed = JSON.parse(jsonResult.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      const [entry] = parsed;
      expect(entry.status).toBe("failed");
      expect(entry.lifecycle).toBeDefined();
      expect(entry.lifecycle.after_up).toBeDefined();
      expect(entry.lifecycle.after_up.status).toBe("failed");
      expect(entry.lifecycle.after_up.failed_index).toBe(1);
      expect(entry.lifecycle.after_up.total).toBe(3);
      expect(entry.lifecycle.after_up.failed_cmd).toBe(
        "echo db-reset && false",
      );
      const logPath = entry.lifecycle.after_up.log_path;
      expect(typeof logPath).toBe("string");
      expect(logPath).toContain(stackId!);
      expect(logPath).toContain("after_up.log");
      expect(existsSync(logPath)).toBe(true);
    },
    60_000,
  );

  it(
    "JSON reports `ok` for every phase that ran cleanly",
    async () => {
      fixture = makeFixture(CLEAN_YAML);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const jsonResult = runLich(["stacks", "--json"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      expect(jsonResult.exitCode).toBe(0);
      const [entry] = JSON.parse(jsonResult.stdout);
      expect(entry.lifecycle).toBeDefined();
      expect(entry.lifecycle.before_up).toEqual({ status: "ok" });
      expect(entry.lifecycle.after_up).toEqual({ status: "ok" });
      // Down phases haven't run yet — omitted from the shape.
      expect("before_down" in entry.lifecycle).toBe(false);
      expect("after_down" in entry.lifecycle).toBe(false);

      // Table reflects clean status — no suffix
      const tableResult = runLich(["stacks"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });
      expect(tableResult.exitCode).toBe(0);
      expect(tableResult.stdout).not.toContain("failed (");
    },
    60_000,
  );
});
