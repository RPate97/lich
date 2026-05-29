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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { LICH_BINARY, REPO_ROOT } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(LICH_BINARY)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(REPO_ROOT, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(`failed to build lich binary (exit ${build.status})`);
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
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-down-yaml-edit-home-"));
  return { stackPath: stack.path, stackCleanup: stack.cleanup, lichHome: home };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
    });
  } catch { /* best-effort */ }
  try { fix.stackCleanup(); } catch { /* best-effort */ }
  try { rmSync(fix.lichHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

function findStackId(lichHome: string): string | null {
  const root = join(lichHome, "stacks");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((n) => {
    try { return statSync(join(root, n)).isDirectory(); } catch { return false; }
  });
  return dirs[0] ?? null;
}

function readStateJson(lichHome: string, stackId: string): {
  status: string;
  services: Array<{ name: string; state: string; resolved_env?: Record<string, string>; stop_cmd?: string; depends_on?: string[] }>;
  before_down?: Array<{ cmd: string; env: Record<string, string> }>;
  after_down?: Array<{ cmd: string; env: Record<string, string> }>;
} {
  const p = join(lichHome, "stacks", stackId, "state.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

function makeYaml(workerId: string, logFile: string): string {
  return `version: "1"

env:
  WORKER_ID: "${workerId}"

owned:
  worker:
    cmd: "sleep 9999"
    stop_cmd: "echo $WORKER_ID > ${logFile}"

  events:
    cmd: "sleep 9999"
    depends_on: [worker]

profiles:
  dev:
    default: true
    owned: [worker, events]
`;
}

describe("lich down uses snapshot env (LEV-513)", () => {
  it(
    "stop_cmd runs with the env resolved at up time, not the yaml-edited env",
    () => {
      const stopLogFile = join(mkdtempSync(join(tmpdir(), "lich-lev513-")), "stop.log");
      const yamlA = makeYaml("original-id", stopLogFile);

      fixture = makeFixture(yamlA);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}):\n` +
            `--- stdout ---\n${upResult.stdout}\n--- stderr ---\n${upResult.stderr}`,
        );
      }

      const stackId = findStackId(lichHome);
      expect(stackId, "expected a stack dir after lich up").not.toBeNull();

      const snapAfterUp = readStateJson(lichHome, stackId!);
      expect(snapAfterUp.status).toBe("up");
      const workerSnap = snapAfterUp.services.find((s) => s.name === "worker");
      expect(workerSnap, "worker service missing from state.json").toBeDefined();
      expect(
        workerSnap!.resolved_env,
        "resolved_env should be snapshotted (post-LEV-513)",
      ).toBeDefined();
      expect(workerSnap!.resolved_env!.WORKER_ID).toBe("original-id");
      expect(workerSnap!.stop_cmd).toBe(`echo $WORKER_ID > ${stopLogFile}`);
      const eventsSnap = snapAfterUp.services.find((s) => s.name === "events");
      expect(eventsSnap?.depends_on).toEqual(["worker"]);

      // Edit lich.yaml: change WORKER_ID to a different value.
      const yamlB = makeYaml("edited-id", stopLogFile);
      writeFileSync(join(stackPath, "lich.yaml"), yamlB, "utf8");

      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(
        downResult.exitCode,
        `lich down failed (exit ${downResult.exitCode}):\n` +
          `--- stdout ---\n${downResult.stdout}\n--- stderr ---\n${downResult.stderr}`,
      ).toBe(0);

      expect(
        existsSync(stopLogFile),
        `stop_cmd did not write the log file at ${stopLogFile}`,
      ).toBe(true);
      const stopLog = readFileSync(stopLogFile, "utf8").trim();
      expect(
        stopLog,
        `stop_cmd ran with WORKER_ID="${stopLog}" — expected "original-id" (snapshotted value, not "edited-id" from edited yaml)`,
      ).toBe("original-id");

      const snapAfterDown = readStateJson(lichHome, stackId!);
      expect(snapAfterDown.status).toBe("stopped");
    },
    60_000,
  );

  it(
    "down still works when lich.yaml is deleted after lich up",
    () => {
      const yamlA = makeYaml("deleted-yaml-id", "/dev/null");
      fixture = makeFixture(yamlA);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        throw new Error(
          `lich up failed:\n${upResult.stdout}\n${upResult.stderr}`,
        );
      }

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      rmSync(join(stackPath, "lich.yaml"), { force: true });
      expect(existsSync(join(stackPath, "lich.yaml"))).toBe(false);

      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(
        downResult.exitCode,
        `lich down failed without yaml:\n${downResult.stdout}\n${downResult.stderr}`,
      ).toBe(0);

      const snapAfterDown = readStateJson(lichHome, stackId!);
      expect(snapAfterDown.status).toBe("stopped");

      expect(
        downResult.stdout + downResult.stderr,
        "no 'lich.yaml not found' warning expected when snapshot carries teardown data",
      ).not.toContain("lich.yaml not found");
    },
    60_000,
  );
});
