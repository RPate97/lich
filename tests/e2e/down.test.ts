/**
 * Plan 1 Task 31 — `lich down` clean teardown (LEV-298).
 *
 * Verifies that after a successful `lich up` followed by `lich down`, the
 * system is left with NO leftover resources:
 *
 *   - docker containers under the stack's compose project are gone
 *   - owned host processes (PIDs recorded in state.json) are dead
 *   - allocated ports are free (a fresh process can bind them)
 *   - the stack's entry in `~/.lich/ports.json` is removed
 *   - state.json reports `status: 'stopped'`
 *
 * Also verifies the idempotency guarantee: running `lich down` again on a
 * stopped stack is a clean no-op (exit 0, no warnings about "already
 * stopped").
 *
 * Heavy test — supabase startup alone can take 60-90s. Total runtime budget
 * is ~5 minutes (timeout set on the describe block).
 *
 * Runs unconditionally. Requires docker + supabase CLI v2+ on the host;
 * without them, `lich up` fails loudly with the real underlying error
 * (see tests/e2e/README.md and LEV-314).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runLich } from "./helpers/lich.js";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const LICH_BINARY = resolve(REPO_ROOT, "packages/lich/dist/lich");

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

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

/** Find the stack_id under lichHome by scanning the stacks/ directory. */
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

// ---------------------------------------------------------------------------
// Probes for the post-down assertions
// ---------------------------------------------------------------------------

/** True iff the given pid is currently alive (signal 0 doesn't ESRCH). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to bind to a port. Resolves true if the port is free (we could bind
 * and immediately released), false otherwise.
 */
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

/**
 * Capture the list of docker container IDs under a compose project. Empty
 * array if no containers exist. Docker is a hard prerequisite for this
 * suite (LEV-314); if it's missing the earlier `lich up` step will have
 * failed loudly already.
 */
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

/**
 * True iff a docker container with the given id is still present on the
 * host (running or stopped). Uses `docker ps -a --filter "id=<id>"` and
 * checks for any output.
 */
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let cleanup: (() => void) | null = null;
let tmpPath: string | null = null;
let lichHome: string | null = null;

afterEach(() => {
  // Defensive nuke: if the test bailed before `lich down` could run (e.g.
  // assertion failed mid-test, lich up crashed leaving owned processes
  // running), `lich nuke --yes` against this test's LICH_HOME kills every
  // recorded service and clears state. Failures here are swallowed — the
  // tmpdir removal below will dispose of state files either way, and we
  // don't want a flaky nuke to mask the real test failure.
  if (lichHome !== null && tmpPath !== null) {
    try {
      runLich(["nuke", "--yes"], {
        cwd: tmpPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }

  // tmpdir cleanup.
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  tmpPath = null;
  lichHome = null;
});

afterAll(() => {
  // Per-test LICH_HOME was inside the tmpdir, so afterEach already disposed
  // of state. No additional global cleanup needed.
});

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe(
  "lich down leaves no leftover resources",
  () => {
    beforeAll(() => {
      // Sanity: the compiled binary must exist. Plan 0 / Plan 1 task
      // expectation: `bun run build` was run before invoking the e2e suite.
      if (!existsSync(LICH_BINARY)) {
        throw new Error(
          `lich binary not found at ${LICH_BINARY}. Run \`cd packages/lich && bun run build\` first.`,
        );
      }
    });

    it(
      "down removes containers, kills pids, releases ports, marks status:stopped, and is idempotent",
      async () => {
        // ---- ARRANGE ---------------------------------------------------
        // install: true — apps/web runs `next dev`, which needs `next` in
        // node_modules/.bin. Without it the web owned service exits 127
        // immediately and `lich up` fails before any state.json is written.
        // See LEV-313.
        const fixture = copyExampleToTmpdir("dogfood-stack", { install: true });
        tmpPath = fixture.path;
        cleanup = fixture.cleanup;

        lichHome = join(tmpPath, ".lich");

        const env: Record<string, string> = {
          LICH_HOME: lichHome,
        };

        // ---- ACT 1: lich up --------------------------------------------
        // `lich up` is synchronous-blocking: it returns once the stack is up
        // (all services ready) or fails. Owned services are NOT killed when
        // the lich CLI exits — that's the whole point of `lich down`.
        const upResult = runLich(["up"], {
          cwd: tmpPath,
          env,
          timeout: 180_000,
        });

        if (upResult.exitCode !== 0) {
          // If `lich up` couldn't bring the stack up (e.g. flaky local env),
          // bail with the captured output so debugging is straightforward.
          throw new Error(
            `lich up failed (exit ${upResult.exitCode}). Test cannot proceed.\n` +
              `--- stdout ---\n${upResult.stdout}\n` +
              `--- stderr ---\n${upResult.stderr}`,
          );
        }

        // ---- CAPTURE pre-down state -----------------------------------
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

        // ports.json must contain an entry for this stack now.
        const portsBefore = readPortsJson(lichHome);
        expect(portsBefore).not.toBeNull();
        expect(portsBefore!.allocations[stackId]).toBeDefined();

        // Compose containers for this stack's compose project. dogfood-stack
        // declares no `services:` (only `owned:`), so this is expected to be
        // empty in practice — but we still capture for completeness.
        const composeProject = `lich-${stackId}`;
        const containerIdsBefore = composeContainerIds(composeProject);

        // ---- ACT 2: lich down ------------------------------------------
        const downResult = runLich(["down"], {
          cwd: tmpPath,
          env,
          timeout: 120_000,
        });
        expect(downResult.exitCode).toBe(0);

        // ---- ASSERT post-down ------------------------------------------

        // 1. state.json reports status:stopped.
        const snapAfter = readStateJson(lichHome, stackId);
        expect(snapAfter.status).toBe("stopped");

        // 2. Owned PIDs are dead.
        for (const pid of ownedPidsBefore) {
          expect(isPidAlive(pid)).toBe(false);
        }

        // 3. Allocated ports are free.
        for (const port of allocatedPortsBefore) {
          // eslint-disable-next-line no-await-in-loop
          const free = await isPortFree(port);
          expect(
            free,
            `expected port ${port} to be free after down, but it was still bound`,
          ).toBe(true);
        }

        // 4. ports.json no longer carries the stack's entry.
        const portsAfter = readPortsJson(lichHome);
        // The file should still exist (other stacks may be tracked), but
        // this stack's allocation entry is gone.
        if (portsAfter !== null) {
          expect(portsAfter.allocations[stackId]).toBeUndefined();
        }

        // 5. Docker containers for the compose project are gone.
        for (const id of containerIdsBefore) {
          expect(
            dockerContainerExists(id),
            `expected docker container ${id} to be gone after down, but it still exists`,
          ).toBe(false);
        }
        // Defense in depth: a fresh `docker compose -p <project> ps -q -a`
        // should return nothing.
        expect(composeContainerIds(composeProject)).toEqual([]);

        // ---- ACT 3: lich down again (idempotency) ----------------------
        const downAgain = runLich(["down"], {
          cwd: tmpPath,
          env,
          timeout: 30_000,
        });
        expect(downAgain.exitCode).toBe(0);
        // No warnings about teardown failures should be printed. The down
        // command for an already-stopped stack writes a short
        // "stack already stopped: ..." line and exits.
        expect(downAgain.stderr).toBe("");
        // We don't assert on the exact stdout phrasing — the contract is
        // exit 0 + no warnings. If the implementation chooses to print
        // "already stopped" or stays silent, both are fine.
        expect(downAgain.stdout).not.toMatch(/warning\(s\) during teardown/i);
      },
      // 5-minute timeout: supabase cold start + lich up + lich down +
      // idempotent re-run. The default 120s is too tight.
      300_000,
    );
  },
);

