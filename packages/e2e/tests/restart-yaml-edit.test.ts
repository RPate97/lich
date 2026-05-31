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
  outDir: string;
}

let fixture: Fixture | null = null;

function makeFixture(yaml: string): Fixture {
  const stack = copyFixtureToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-restart-yaml-edit-home-"));
  const outDir = mkdtempSync(join(tmpdir(), "lich-e2e-restart-yaml-edit-out-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
    outDir,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
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
  try { rmSync(fix.outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

interface StateJson {
  status: string;
  services: Array<{
    name: string;
    kind: string;
    state: string;
    resolved_env?: Record<string, string>;
    cmd?: string;
    allocated_ports?: Record<string, number>;
  }>;
}

function readStateJson(lichHome: string, stackId: string): StateJson {
  const p = join(lichHome, "stacks", stackId, "state.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

// Single owned service. On each spawn it appends $WORKER_ID to a marker file,
// then sleeps. Lets us prove which env the service was started with across an up
// and a restart by inspecting the marker file's contents.
function makeYaml(workerId: string, markerFile: string): string {
  return `version: "1"

env:
  WORKER_ID: "${workerId}"

owned:
  worker:
    cmd: 'printf "%s\\n" "$WORKER_ID" >> ${markerFile}; sleep 9999'
`;
}

describe("lich restart uses snapshot env, not edited yaml env (LEV-527)", () => {
  it(
    "after up, edit yaml env, restart — restarted service still sees up-time env",
    () => {
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-lev527-")), "worker.log");
      const yamlA = makeYaml("original-id", markerFile);
      fixture = makeFixture(yamlA);
      const { stackPath, lichHome } = fixture;

      // up
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(
        upResult.exitCode,
        `lich up failed (exit ${upResult.exitCode}):\n` +
          `--- stdout ---\n${upResult.stdout}\n--- stderr ---\n${upResult.stderr}`,
      ).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snapAfterUp = readStateJson(lichHome, stackId!);
      const workerAfterUp = snapAfterUp.services.find((s) => s.name === "worker");
      expect(workerAfterUp?.resolved_env?.WORKER_ID).toBe("original-id");

      // Wait for the service to write its marker line, then verify content.
      // The cmd writes the line on startup, so the file should exist within 1-2s.
      const waitForLine = (expectedLines: number, timeoutMs: number): string => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (existsSync(markerFile)) {
            const lines = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
            if (lines.length >= expectedLines) return lines.join("\n");
          }
          // small busy loop OK for sub-second waits in a sync test
          const start = Date.now();
          while (Date.now() - start < 100) { /* busy */ }
        }
        throw new Error(
          `timed out waiting for ${expectedLines} line(s) in marker file ${markerFile}; ` +
            `current contents: ${existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "(missing)"}`,
        );
      };

      const linesAfterUp = waitForLine(1, 10_000).split("\n");
      expect(linesAfterUp).toEqual(["original-id"]);

      // Edit yaml: change WORKER_ID. If restart re-resolves from yaml, the next
      // line in the marker file would be "edited-id". We want it to stay "original-id".
      const yamlB = makeYaml("edited-id", markerFile);
      writeFileSync(join(stackPath, "lich.yaml"), yamlB, "utf8");

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(
        restartResult.exitCode,
        `lich restart failed (exit ${restartResult.exitCode}):\n` +
          `--- stdout ---\n${restartResult.stdout}\n--- stderr ---\n${restartResult.stderr}`,
      ).toBe(0);

      // Snapshot's resolved_env must still hold the up-time value
      const snapAfterRestart = readStateJson(lichHome, stackId!);
      const workerAfterRestart = snapAfterRestart.services.find((s) => s.name === "worker");
      expect(
        workerAfterRestart?.resolved_env?.WORKER_ID,
        "post-restart snapshot must still carry the up-time WORKER_ID, not the edited yaml value",
      ).toBe("original-id");

      // And the running service itself wrote a second line with the up-time value
      const linesAfterRestart = waitForLine(2, 15_000).split("\n");
      expect(
        linesAfterRestart,
        `marker file must have exactly two "original-id" lines (one per cmd invocation); ` +
          `if the second line is "edited-id", the bug is back`,
      ).toEqual(["original-id", "original-id"]);
    },
    120_000,
  );

  it(
    "legacy snapshot (no resolved_env on owned service) — restart falls back to yaml re-resolution",
    () => {
      // Write a minimal yaml. Up writes resolved_env. We then strip resolved_env
      // from state.json to simulate a pre-LEV-513 snapshot, edit the yaml env,
      // and restart. With the fallback path, the restarted service must use
      // the EDITED yaml env (since no snapshot env is available).
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-lev527-legacy-")), "worker.log");
      const yamlA = makeYaml("up-time-id", markerFile);
      fixture = makeFixture(yamlA);
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      // Wait for the first marker line to be written before tampering with state.json
      const waitForLine = (expectedLines: number, timeoutMs: number): string => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (existsSync(markerFile)) {
            const lines = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
            if (lines.length >= expectedLines) return lines.join("\n");
          }
          const start = Date.now();
          while (Date.now() - start < 100) { /* busy */ }
        }
        throw new Error(`timeout waiting for ${expectedLines} line(s)`);
      };
      const linesAfterUp = waitForLine(1, 10_000).split("\n");
      expect(linesAfterUp).toEqual(["up-time-id"]);

      // Strip resolved_env / cmd / service_cwd from the snapshot — simulates legacy state.json
      const statePath = join(lichHome, "stacks", stackId!, "state.json");
      const snap = JSON.parse(readFileSync(statePath, "utf8"));
      for (const svc of snap.services) {
        if (svc.kind === "owned") {
          delete svc.resolved_env;
          delete svc.cmd;
          delete svc.service_cwd;
          delete svc.stop_cmd;
        }
      }
      writeFileSync(statePath, JSON.stringify(snap, null, 2) + "\n", "utf8");

      // Edit yaml to a new WORKER_ID
      const yamlB = makeYaml("post-edit-id", markerFile);
      writeFileSync(join(stackPath, "lich.yaml"), yamlB, "utf8");

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(
        restartResult.exitCode,
        `lich restart failed:\n${restartResult.stdout}\n${restartResult.stderr}`,
      ).toBe(0);

      // Legacy fallback: the restarted service must see the EDITED yaml env,
      // because no snapshot env was available to override.
      const linesAfterRestart = waitForLine(2, 15_000).split("\n");
      expect(
        linesAfterRestart,
        "legacy snapshot fallback: restart should re-resolve from yaml since resolved_env is absent",
      ).toEqual(["up-time-id", "post-edit-id"]);
    },
    120_000,
  );
});
