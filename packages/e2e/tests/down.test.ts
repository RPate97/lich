import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runLich } from "../helpers/lich.js";
import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { LICH_BINARY } from "@/helpers/paths.js";

interface ServiceSnapshot {
  name: string;
  kind: "compose" | "owned";
  state: string;
  allocated_ports?: Record<string, number>;
  pid?: number;
}

interface StackSnapshot {
  stack_id: string;
  worktree_name: string;
  worktree_path: string;
  status: string;
  started_at: string;
  services: ServiceSnapshot[];
}

function readStateJson(lichHome: string, stackId: string): StackSnapshot {
  const p = join(lichHome, "stacks", stackId, "state.json");
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw) as StackSnapshot;
}

function readPortsJson(
  lichHome: string,
): { allocations: Record<string, Record<string, number>> } | null {
  const p = join(lichHome, "ports.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function findStackId(lichHome: string): string {
  const stacksDir = join(lichHome, "stacks");
  if (!existsSync(stacksDir)) {
    throw new Error(`no stacks directory under ${lichHome} after lich up`);
  }
  const names = readdirSync(stacksDir).filter((s) => s.length > 0);
  if (names.length !== 1) {
    throw new Error(
      `expected exactly one stack dir under ${stacksDir}, found ${names.length}: ${names.join(", ")}`,
    );
  }
  return names[0];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

function composeContainerIds(project: string): string[] {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "ps", "-q", "-a"],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function dockerContainerExists(id: string): boolean {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `id=${id}`, "--format", "{{.ID}}"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.status !== 0) return false;
  return (result.stdout ?? "").trim().length > 0;
}

let cleanup: (() => void) | null = null;
let tmpPath: string | null = null;
let lichHome: string | null = null;

afterEach(() => {
  if (lichHome !== null && tmpPath !== null) {
    try {
      runLich(["nuke", "--yes"], {
        cwd: tmpPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });
    } catch {
      /* best-effort */
    }
  }

  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  tmpPath = null;
  lichHome = null;
});

afterAll(() => {
  // per-test LICH_HOME lives in tmpdir; nothing extra to clean
});

describe(
  "lich down leaves no leftover resources",
  () => {
    beforeAll(() => {
      if (!existsSync(LICH_BINARY)) {
        throw new Error(
          `lich binary not found at ${LICH_BINARY}. Run \`cd packages/lich && bun run build\` first.`,
        );
      }
    });

    it(
      "down removes containers, kills pids, releases ports, marks status:stopped, and is idempotent",
      async () => {
        const fixture = copyExampleToTmpdir("dogfood-stack", { install: true });
        tmpPath = fixture.path;
        cleanup = fixture.cleanup;

        lichHome = join(tmpPath, ".lich");

        const env: Record<string, string> = {
          LICH_HOME: lichHome,
        };

        const upResult = runLich(["up"], {
          cwd: tmpPath,
          env,
          timeout: 180_000,
        });

        if (upResult.exitCode !== 0) {
          throw new Error(
            `lich up failed (exit ${upResult.exitCode}). Test cannot proceed.\n` +
              `--- stdout ---\n${upResult.stdout}\n` +
              `--- stderr ---\n${upResult.stderr}`,
          );
        }

        const stackId = findStackId(lichHome);
        const snapBefore = readStateJson(lichHome, stackId);
        expect(snapBefore.status).toBe("up");

        const ownedPidsBefore: number[] = [];
        const allocatedPortsBefore: number[] = [];
        for (const svc of snapBefore.services) {
          if (svc.kind === "owned" && typeof svc.pid === "number") {
            ownedPidsBefore.push(svc.pid);
          }
          if (svc.allocated_ports) {
            for (const port of Object.values(svc.allocated_ports)) {
              allocatedPortsBefore.push(port);
            }
          }
        }

        const portsBefore = readPortsJson(lichHome);
        expect(portsBefore).not.toBeNull();
        expect(portsBefore!.allocations[stackId]).toBeDefined();

        const composeProject = `lich-${stackId}`;
        const containerIdsBefore = composeContainerIds(composeProject);

        const downResult = runLich(["down"], {
          cwd: tmpPath,
          env,
          timeout: 120_000,
        });
        expect(downResult.exitCode).toBe(0);

        const snapAfter = readStateJson(lichHome, stackId);
        expect(snapAfter.status).toBe("stopped");

        for (const pid of ownedPidsBefore) {
          expect(isPidAlive(pid)).toBe(false);
        }

        for (const port of allocatedPortsBefore) {
          // eslint-disable-next-line no-await-in-loop
          const free = await isPortFree(port);
          expect(
            free,
            `expected port ${port} to be free after down, but it was still bound`,
          ).toBe(true);
        }

        const portsAfter = readPortsJson(lichHome);
        if (portsAfter !== null) {
          expect(portsAfter.allocations[stackId]).toBeUndefined();
        }

        for (const id of containerIdsBefore) {
          expect(
            dockerContainerExists(id),
            `expected docker container ${id} to be gone after down, but it still exists`,
          ).toBe(false);
        }
        expect(composeContainerIds(composeProject)).toEqual([]);

        // idempotent re-run
        const downAgain = runLich(["down"], {
          cwd: tmpPath,
          env,
          timeout: 30_000,
        });
        expect(downAgain.exitCode).toBe(0);
        expect(downAgain.stderr).toBe("");
        expect(downAgain.stdout).not.toMatch(/warning\(s\) during teardown/i);
      },
      300_000,
    );
  },
);

