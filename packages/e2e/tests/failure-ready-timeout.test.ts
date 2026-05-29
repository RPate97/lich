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
import { readStateJson } from "../helpers/state.js";
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

// hang's port never gets bound → http_get probe times out at 3s.
// quick_ready in same level is the "scoped failure" sentinel.
const MINIMAL_LICH_YAML = `version: "1"

owned:
  hang:
    cmd: 'sleep 99999'
    port: { env: PORT }
    ready_when:
      http_get: '/nope'
      timeout: '3s'

  quick_ready:
    cmd: 'echo "I am ready"; sleep 99999'
    ready_when:
      log_match: "I am ready"
`;

function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack");
  writeFileSync(join(stack.path, "lich.yaml"), MINIMAL_LICH_YAML, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-failure-ready-timeout-home-"),
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

describe("lich up — ready_when.timeout fires and surfaces", () => {
  it(
    "fails the hang service at the 3s timeout, leaves quick_ready healthy, and records the failure in state.json",
    () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      if (validateResult.exitCode !== 0) {
        throw new Error(
          `minimal lich.yaml failed validate — the test fixture is broken.\n` +
            `--- validate stdout ---\n${validateResult.stdout}\n` +
            `--- validate stderr ---\n${validateResult.stderr}`,
        );
      }

      // 3s timeout + level coordination overhead; 30s ceiling for slow CI
      const t0 = Date.now();
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsedMs = Date.now() - t0;

      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected success — stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected success — stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);

      expect(
        elapsedMs,
        `lich up took ${elapsedMs}ms (budget 20s); the 3s timeout should fire ` +
          `well within this window`,
      ).toBeLessThan(20_000);

      const combined = upResult.stdout + upResult.stderr;

      expect(combined).toContain("hang");

      // formatter reason: "ready_when did not satisfy within 3s (http_get)"
      expect(combined).toContain("within 3s");

      const stackId = findStackId(lichHome);
      expect(
        stackId,
        `no stack dir under ${lichHome}/stacks/ — state.json was never written`,
      ).not.toBeNull();
      const snap = readStateJson(lichHome, stackId!);
      expect(
        snap,
        `state.json missing or unparseable for stack ${stackId}`,
      ).not.toBeNull();

      expect(snap!.status).toBe("failed");

      const hangSnap = snap!.services.find((s) => s.name === "hang");
      expect(
        hangSnap,
        `hang missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(hangSnap!.state).toBe("failed");

      // ServiceSnapshot in state.ts doesn't enumerate failure fields
      const hangSnapWithFailure = hangSnap as typeof hangSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(
        hangSnapWithFailure.failure_reason,
        `hang.failure_reason was not populated`,
      ).toBeDefined();
      expect(hangSnapWithFailure.failure_reason).toContain("within 3s");
      expect(
        hangSnapWithFailure.failure_log_tail,
        `hang.failure_log_tail must be present (possibly empty) for a failed service`,
      ).toBeDefined();
      expect(Array.isArray(hangSnapWithFailure.failure_log_tail)).toBe(true);

      const quickSnap = snap!.services.find((s) => s.name === "quick_ready");
      expect(
        quickSnap,
        `quick_ready missing from state.json services: ${snap!.services.map((s) => s.name).join(", ")}`,
      ).toBeDefined();
      expect(
        quickSnap!.state,
        `quick_ready state must not be "failed" (became ready before hang ` +
          `timed out); got "${quickSnap!.state}"`,
      ).not.toBe("failed");

      // sanitizer strips failure fields from non-failed services
      const quickSnapWithFailure = quickSnap as typeof quickSnap & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };
      expect(quickSnapWithFailure.failure_reason).toBeUndefined();
      expect(quickSnapWithFailure.failure_log_tail).toBeUndefined();
    },
    60_000,
  );
});
