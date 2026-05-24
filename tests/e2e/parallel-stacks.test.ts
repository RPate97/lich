/**
 * Parallel-stacks sentinel — REQUIRED per the testing standards
 * (docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md, section
 * "Required parallel-stack test").
 *
 * This test is the load-bearing proof that lich's primary value
 * proposition — running multiple stacks side-by-side without collision —
 * actually works through the real binary.
 *
 * Shape:
 *   1. Two copies of `examples/dogfood-stack/` in two tmpdirs whose
 *      basenames differ (`dogfood-stack-a-XXXX` vs `dogfood-stack-b-XXXX`)
 *      so the worktree-detection code (which slugs the basename) gives
 *      each stack a distinct `name`. The same absolute-path hash already
 *      guarantees distinct `stack_id`s — different basenames just make
 *      the IDs visually distinguishable in diagnostics.
 *   2. ONE shared `LICH_HOME=<tmp>/lich-home` for both invocations. This
 *      mirrors real usage: the registry of allocated ports + the
 *      `~/.lich/stacks/` directory of state.json files is per-machine,
 *      not per-stack. It's also what exercises the file-locked port
 *      allocator (LEV-272) — two concurrent `lich up`s must serialize
 *      through that file lock to avoid handing out the same port twice.
 *   3. Bring up A. Then bring up B. (Concurrent vs sequential `up` both
 *      need to work; the testing-standards spec issues them concurrently,
 *      but the per-task spec requires sequential — `up A` → wait → `up B`
 *      → wait — because we want to assert intermediate state after each
 *      one. Both code paths hit the file lock; sequential is the simpler
 *      assertion shape.)
 *   4. Sentinel assertions:
 *      - state.json for A is status:up; same for B.
 *      - Allocated ports for A and B do not overlap (across every port
 *        every service of either stack received).
 *      - Both web services answer HTTP 200 on their respective ports.
 *      - `lich stacks` (against the shared LICH_HOME) lists BOTH stacks.
 *   5. `lich down` against A leaves B fully running:
 *      - A's state.json transitions to status:stopped.
 *      - B's state.json is still status:up.
 *      - B's web URL still responds 200.
 *   6. `lich down` against B (cleanup).
 *
 * Cleanup contract: both stacks are torn down in `afterAll` even if the
 * test body throws. The tmpdir copies and the shared LICH_HOME are
 * recursively removed. Leaving leaks here would corrupt subsequent runs.
 *
 * Resource budget: starting two full stacks (Supabase + API + web each)
 * is heavy — we extend the test timeout to 5 minutes. On machines without
 * docker / supabase v2+, the suite skips with a clear message rather than
 * failing.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";

// ---------------------------------------------------------------------------
// Environment probes — skip cleanly if the host can't run the test
// ---------------------------------------------------------------------------

/** True if the docker daemon is reachable. */
function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5_000,
  });
  return r.status === 0;
}

/** True if `supabase --version` reports a major version ≥ 2. */
function supabaseV2Available(): boolean {
  const r = spawnSync("supabase", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) return false;
  // Output looks like `2.98.2\n` (possibly followed by an upgrade banner).
  const firstLine = (r.stdout ?? "").split("\n")[0].trim();
  const major = parseInt(firstLine.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 2;
}

const HAVE_DOCKER = dockerAvailable();
const HAVE_SUPABASE_V2 = supabaseV2Available();
const SHOULD_RUN = HAVE_DOCKER && HAVE_SUPABASE_V2;

const SKIP_REASON = !HAVE_DOCKER
  ? "skipped: docker daemon not reachable"
  : !HAVE_SUPABASE_V2
    ? "skipped: supabase CLI v2+ not available"
    : "";

// ---------------------------------------------------------------------------
// Test scope state — shared across the single sentinel test
// ---------------------------------------------------------------------------

interface StackCopy {
  path: string;
  cleanup: () => void;
  /** Tracked spawnLich child (if `up` was issued via spawn rather than sync). */
  proc?: ChildProcess | null;
}

let lichHome: string | null = null;
let stackA: StackCopy | null = null;
let stackB: StackCopy | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `lich up` synchronously against `cwd` with the shared LICH_HOME. We
 * use `runLich` (sync) rather than `spawnLich` because `lich up` returns
 * once the stack is fully ready — we don't need to keep the process alive
 * after that point (services are detached: compose runs in -d mode,
 * owned services are spawned in their own process group by the supervisor).
 *
 * Returns the result so the caller can inspect exit code / stdout / stderr.
 */
function lichUp(cwd: string): ReturnType<typeof runLich> {
  return runLich(["up"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    // up against the dogfood stack is heavy; give it 4 minutes per call.
    timeout: 240_000,
  });
}

/** Run `lich down` synchronously against `cwd`. */
function lichDown(cwd: string): ReturnType<typeof runLich> {
  return runLich(["down"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    timeout: 120_000,
  });
}

/**
 * Read state.json for a worktree by scanning `<LICH_HOME>/stacks/<id>/state.json`
 * and finding the snapshot whose `worktree_path` matches `cwd`.
 *
 * We don't know the stack_id a-priori (it's a hash of the absolute path)
 * so we enumerate and filter rather than guessing.
 */
function readStateForWorktree(
  worktreePath: string,
): {
  stack_id: string;
  status: string;
  services: Array<{
    name: string;
    state: string;
    allocated_ports?: Record<string, number>;
  }>;
} | null {
  const stacksRoot = join(lichHome!, "stacks");
  if (!existsSync(stacksRoot)) return null;

  // Lazy require to avoid pulling fs at the top — keep helper scope local.
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");

  for (const entry of readdirSync(stacksRoot)) {
    const dir = join(stacksRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const statePath = join(dir, "state.json");
    if (!existsSync(statePath)) continue;
    try {
      const snap = JSON.parse(readFileSync(statePath, "utf8")) as {
        stack_id: string;
        worktree_path: string;
        status: string;
        services: Array<{
          name: string;
          state: string;
          allocated_ports?: Record<string, number>;
        }>;
      };
      // realpath collapse: macOS tmpdirs route through /private/var/folders,
      // so worktree.path may differ from the path we copied to by that
      // prefix. Compare suffixes so both `/var/.../X` and `/private/var/.../X`
      // resolve as the same worktree.
      if (
        snap.worktree_path === worktreePath ||
        snap.worktree_path.endsWith(worktreePath) ||
        worktreePath.endsWith(snap.worktree_path)
      ) {
        return snap;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract every allocated host port across every service in a state
 * snapshot. Used to assert that A and B never share a port.
 */
function collectAllocatedPorts(snap: {
  services: Array<{ allocated_ports?: Record<string, number> }>;
}): number[] {
  const out: number[] = [];
  for (const svc of snap.services) {
    if (!svc.allocated_ports) continue;
    for (const port of Object.values(svc.allocated_ports)) {
      out.push(port);
    }
  }
  return out;
}

/**
 * Parse `lich urls` text output into a `{ <key>: port }` map, where `<key>`
 * is `<service>` for single-port services and `<service>.<portKey>` for
 * multi-port. We parse against the printed line format:
 *     `<key>: http://localhost:<port>`
 *
 * Used to locate the `web` service's port for the HTTP 200 probe without
 * coupling the test to internal port-allocator details.
 */
function parseUrls(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\S+):\s+http:\/\/localhost:(\d+)\s*$/);
    if (!m) continue;
    out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!SHOULD_RUN) return;

  // Single shared LICH_HOME — this is the whole point of the sentinel.
  // Both stacks must coexist under one ~/.lich layout.
  lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-parallel-home-"));

  // Two copies with explicitly different basenames so the slugged worktree
  // names visually differ (`dogfood-stack-a-...` vs `dogfood-stack-b-...`).
  //
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127 immediately
  // and `lich up` fails before any state.json is written. See LEV-313.
  stackA = copyExampleToTmpdir("dogfood-stack", {
    prefix: "lich-e2e-dogfood-stack-a-",
    install: true,
  });
  stackB = copyExampleToTmpdir("dogfood-stack", {
    prefix: "lich-e2e-dogfood-stack-b-",
    install: true,
  });
});

afterAll(async () => {
  // Best-effort: tear down whichever stacks are still up, in either order.
  // We swallow failures here — afterAll is the safety net, not the
  // contract — but we DO log so a leak is visible in CI output.
  for (const stack of [stackA, stackB]) {
    if (!stack) continue;
    try {
      lichDown(stack.path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`afterAll lich down failed for ${stack.path}:`, err);
    }
    if (stack.proc && !stack.proc.killed) {
      try {
        stack.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  // Give any background reaping a beat before we yank the tmpdirs.
  await new Promise<void>((r) => setTimeout(r, 1500));

  for (const stack of [stackA, stackB]) {
    if (!stack) continue;
    try {
      stack.cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`afterAll cleanup failed for ${stack.path}:`, err);
    }
  }
  stackA = null;
  stackB = null;

  if (lichHome) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`afterAll lichHome cleanup failed:`, err);
    }
    lichHome = null;
  }
});

// ---------------------------------------------------------------------------
// The sentinel test
// ---------------------------------------------------------------------------

describe("parallel stacks (REQUIRED sentinel)", () => {
  if (!SHOULD_RUN) {
    it.skip(SKIP_REASON, () => {});
    return;
  }

  it(
    "two dogfood-stack copies in distinct worktrees coexist; lich down A leaves B running",
    async () => {
      // We're inside SHOULD_RUN; beforeAll has populated these.
      const a = stackA!;
      const b = stackB!;

      // ---- Bring A up --------------------------------------------------
      const upA = lichUp(a.path);
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up A exited ${upA.exitCode}\n--- stdout ---\n${upA.stdout}\n--- stderr ---\n${upA.stderr}`,
        );
      }
      const stateA1 = readStateForWorktree(a.path);
      expect(stateA1, "state.json for A should exist after up").not.toBeNull();
      expect(stateA1!.status).toBe("up");

      // ---- Bring B up (file-locked allocator must give it different ports)
      const upB = lichUp(b.path);
      if (upB.exitCode !== 0) {
        throw new Error(
          `lich up B exited ${upB.exitCode}\n--- stdout ---\n${upB.stdout}\n--- stderr ---\n${upB.stderr}`,
        );
      }
      const stateB1 = readStateForWorktree(b.path);
      expect(stateB1, "state.json for B should exist after up").not.toBeNull();
      expect(stateB1!.status).toBe("up");

      // After B is up, A must still be up (B's up didn't perturb A's state).
      const stateA2 = readStateForWorktree(a.path);
      expect(stateA2!.status).toBe("up");

      // ---- Sentinel #1: no port overlap -------------------------------
      const portsA = collectAllocatedPorts(stateA2!);
      const portsB = collectAllocatedPorts(stateB1!);
      expect(portsA.length, "A should have allocated ports").toBeGreaterThan(0);
      expect(portsB.length, "B should have allocated ports").toBeGreaterThan(0);
      const overlap = portsA.filter((p) => portsB.includes(p));
      expect(
        overlap,
        `ports must not overlap; saw A=${JSON.stringify(portsA)} B=${JSON.stringify(portsB)}`,
      ).toEqual([]);
      // Sanity: A's stack_id and B's stack_id are distinct.
      expect(stateA2!.stack_id).not.toBe(stateB1!.stack_id);

      // ---- Sentinel #2: lich urls works for both, web is reachable ----
      const urlsA = runLich(["urls"], {
        cwd: a.path,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsA.exitCode).toBe(0);
      const urlsB = runLich(["urls"], {
        cwd: b.path,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsB.exitCode).toBe(0);
      const mapA = parseUrls(urlsA.stdout);
      const mapB = parseUrls(urlsB.stdout);
      const webA = mapA["web"];
      const webB = mapB["web"];
      expect(webA, `web port for A; got urls:\n${urlsA.stdout}`).toBeTypeOf(
        "number",
      );
      expect(webB, `web port for B; got urls:\n${urlsB.stdout}`).toBeTypeOf(
        "number",
      );
      expect(webA).not.toBe(webB);

      // Both web URLs serve traffic — proves the stacks are truly running
      // in parallel, not just having state.json say so.
      await waitForHttp200(`http://localhost:${webA}/`, { timeoutMs: 60_000 });
      await waitForHttp200(`http://localhost:${webB}/`, { timeoutMs: 60_000 });

      // ---- Sentinel #3: lich stacks (from a third spawn) lists BOTH ---
      // Run `lich stacks` from a directory that is NOT inside either copy
      // so the listing must come from the shared LICH_HOME rather than
      // worktree detection. We use lichHome itself as the cwd — it's an
      // empty directory not under any lich.yaml, so `stacks` falls back to
      // pure registry-reading behavior.
      const stacks = runLich(["stacks", "--json"], {
        cwd: lichHome!,
        env: { LICH_HOME: lichHome! },
      });
      expect(stacks.exitCode).toBe(0);
      const stacksJson = JSON.parse(stacks.stdout) as Array<{
        stack_id: string;
        status: string;
      }>;
      expect(stacksJson.length).toBeGreaterThanOrEqual(2);
      const idsListed = stacksJson.map((s) => s.stack_id);
      expect(idsListed).toContain(stateA2!.stack_id);
      expect(idsListed).toContain(stateB1!.stack_id);

      // ---- Take A down; B must be unaffected --------------------------
      const downA = lichDown(a.path);
      if (downA.exitCode !== 0) {
        throw new Error(
          `lich down A exited ${downA.exitCode}\n--- stdout ---\n${downA.stdout}\n--- stderr ---\n${downA.stderr}`,
        );
      }

      const stateA3 = readStateForWorktree(a.path);
      expect(stateA3!.status).toBe("stopped");

      const stateB2 = readStateForWorktree(b.path);
      expect(
        stateB2!.status,
        "B must still be up after A is taken down",
      ).toBe("up");

      // B's web URL still serves — the load-bearing assertion that down A
      // didn't accidentally reach into B's resources.
      await waitForHttp200(`http://localhost:${webB}/`, { timeoutMs: 30_000 });

      // ---- Take B down (explicit cleanup; afterAll is a safety net) ---
      const downB = lichDown(b.path);
      if (downB.exitCode !== 0) {
        throw new Error(
          `lich down B exited ${downB.exitCode}\n--- stdout ---\n${downB.stdout}\n--- stderr ---\n${downB.stderr}`,
        );
      }
      const stateB3 = readStateForWorktree(b.path);
      expect(stateB3!.status).toBe("stopped");
    },
    // 5-minute timeout — two full stack starts plus assertions.
    300_000,
  );
});

// Reference spawnLich so the import isn't tree-shaken — the helper exists
// for the streaming-up shape future tests may want, but the sentinel uses
// the synchronous `lich up` path (which itself returns once ready).
void spawnLich;
