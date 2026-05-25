/**
 * Parallel-stacks sentinel — REQUIRED per the testing standards
 * (docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md, section
 * "Required parallel-stack test").
 *
 * This test is the load-bearing proof that lich's primary value
 * proposition — running multiple stacks side-by-side without collision —
 * actually works through the real binary.
 *
 * This file contains TWO independent describe blocks:
 *
 *   1. `parallel stacks (REQUIRED sentinel)` — the original
 *      profile-agnostic sentinel. Two dogfood-stack copies, default
 *      profile resolution, port-isolation assertions, take-A-down-while-B-
 *      runs verification. Pre-dates profiles support.
 *   2. `parallel stacks with profiles (Plan 3 Task 26)` — LEV-400. Exercises
 *      the profile-aware machinery in a parallel-stacks shape: each
 *      worktree comes up under a profile, the snapshot records
 *      `active_profile`, the registry serializes it through `lich stacks
 *      --json`, and worktree isolation still holds across both. See that
 *      block's JSDoc for the design notes (and the explicit deviation from
 *      the literal Linear-issue recipe).
 *
 * Sentinel shape (block 1):
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
 * Resource budget: starting two full stacks (postgres + API + web each)
 * is much lighter than the previous supabase-based setup (LEV-463 swap),
 * but the 5-minute per-test timeout stays as headroom for slow CI. Tests
 * run unconditionally; without docker on the host, `lich up` fails loudly
 * with the real underlying error (see tests/e2e/README.md and LEV-314).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";

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
  it(
    "two dogfood-stack copies in distinct worktrees coexist; lich down A leaves B running",
    async () => {
      // beforeAll has populated these unconditionally.
      const a = stackA!;
      const b = stackB!;

      // Progress logger. Writes to stderr, which bun displays live during
      // the test rather than buffering until the it() resolves. Without
      // these the test could go silent (lich up is synchronous and even
      // postgres pull adds a few seconds on cold cache).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- Bring A up --------------------------------------------------
      step("lich up A (postgres pull + boot ~5-10s)");
      const upA = lichUp(a.path);
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up A exited ${upA.exitCode}\n--- stdout ---\n${upA.stdout}\n--- stderr ---\n${upA.stderr}`,
        );
      }
      const stateA1 = readStateForWorktree(a.path);
      expect(stateA1, "state.json for A should exist after up").not.toBeNull();
      expect(stateA1!.status).toBe("up");
      step(`A up (stack_id=${stateA1!.stack_id})`);

      // ---- Bring B up (file-locked allocator must give it different ports)
      step("lich up B");
      const upB = lichUp(b.path);
      if (upB.exitCode !== 0) {
        throw new Error(
          `lich up B exited ${upB.exitCode}\n--- stdout ---\n${upB.stdout}\n--- stderr ---\n${upB.stderr}`,
        );
      }
      const stateB1 = readStateForWorktree(b.path);
      expect(stateB1, "state.json for B should exist after up").not.toBeNull();
      expect(stateB1!.status).toBe("up");
      step(`B up (stack_id=${stateB1!.stack_id})`);

      // After B is up, A must still be up (B's up didn't perturb A's state).
      const stateA2 = readStateForWorktree(a.path);
      expect(stateA2!.status).toBe("up");
      step("A still up after B's up (no cross-stack interference)");

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
      // Web (Next.js dev) cold compile on first request usually ~3-8s.
      // 20s headroom; if it's slower than that, something is wrong rather
      // than "the server is still starting."
      step(`probing A web (port ${webA})`);
      await waitForHttp200(`http://localhost:${webA}/`, { timeoutMs: 20_000 });
      step(`A web 200 OK, probing B web (port ${webB})`);
      await waitForHttp200(`http://localhost:${webB}/`, { timeoutMs: 20_000 });
      step("B web 200 OK");

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
      step("lich down A");
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
      step("A down; verifying B web still 200 OK");
      await waitForHttp200(`http://localhost:${webB}/`, { timeoutMs: 10_000 });
      step("B still serving after A teardown — sentinel passed");

      // ---- Take B down (explicit cleanup; afterAll is a safety net) ---
      step("lich down B");
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

// ---------------------------------------------------------------------------
// Plan 3 Task 26 (LEV-400) — parallel stacks with profiles.
//
// Scope: prove the profile-aware machinery (resolve, env layering,
// lifecycle composition, snapshot persistence, `lich stacks --json`
// serialization) doesn't break the parallel-stacks isolation contract.
// Each worktree comes up under a DIFFERENT profile, the snapshot records
// the right `active_profile`, the registry surfaces it on the wire, and
// the two stacks coexist without port collisions.
//
// Topology:
//   - Worktree A: `lich up dev` — the default profile, all services start
//     and the dev-profile `after_up` (psql migrations + seed) succeeds
//     because `DATABASE_URL` resolves to the local postgres compose
//     service. End state: status:up, active_profile:dev.
//   - Worktree B: `lich up dev:env-override` — extends dev (so the
//     services/owned list is identical: postgres + api + web + tunnel_demo)
//     but overrides `DATABASE_URL` to
//     `postgresql://postgres:test@db.test.example.com:5432/dogfood`.
//     All services still start (port allocator runs, postgres comes up,
//     api+web come up). The inherited `after_up` then runs the two psql
//     steps against the OVERRIDDEN URL (post-LEV-455 this is properly
//     profile-aware), libpq tries to reach `db.test.example.com`, gets a
//     "could not translate host name" error in ~50ms, exits non-zero.
//     The after_up phase aborts, `lich up` returns exit 1, the stack is
//     marked status:failed with active_profile:dev:env-override preserved.
//     Owned services are NOT torn down automatically on after_up failure
//     (see commands/up.ts:960-973), so their state.json entries still show
//     `ready` and the docker compose stack is still running — exactly the
//     "partial" failure mode the task description called out.
//
//   This is the "accept that after_up fails" branch the task description
//   offered. The dogfood YAML's `dev:env-override` comment explicitly says
//   e2e tests should assert on the env Lich resolved, NOT on actually
//   opening a DB connection — but THIS test's contract is "two stacks
//   with different profiles coexist", not "the override hostname works."
//   So we accept the predictable failure of B's seed step and pin the
//   richer assertion shape:
//     - A: status:up, active_profile:dev
//     - B: status:failed, active_profile:dev:env-override
//     - both: distinct stack_ids, distinct port allocations, both surface
//       via `lich stacks --json` with their respective active_profile
//   The "different profiles coexist in the same registry" claim is fully
//   exercised — the profile NAME makes it through every link of the chain
//   (resolveProfile → snapshot → registry serializer) for two parallel
//   stacks under the same LICH_HOME.
//
// Why we read state.json directly AND via `lich stacks --json`:
//   The on-disk snapshot is the source of truth; the stacks-listing JSON
//   is a derived view. Asserting on both proves the persistence layer AND
//   the serialization layer both round-trip `active_profile` correctly.
//   If a future refactor accidentally drops the field at either layer,
//   this test catches it.
//
// Why a separate describe block (rather than another `it()` under the
// original sentinel block):
//   The two test bodies want INDEPENDENT shared state — distinct
//   LICH_HOME, distinct tmpdirs — so a setup failure in one doesn't
//   poison the other, and the heavy 5-minute timeout applies per-block.
//   Sharing the `lichHome` / `stackA` / `stackB` module locals would
//   couple them to lifecycle order and confuse the cleanup paths. Each
//   describe owns its own fixtures.
// ---------------------------------------------------------------------------

let profilesLichHome: string | null = null;
let profilesStackA: StackCopy | null = null;
let profilesStackB: StackCopy | null = null;

/**
 * Run `lich up <profile>` synchronously against `cwd` with the shared
 * LICH_HOME used by this describe block. Mirrors the top-of-file `lichUp`
 * helper but with an explicit profile arg AND a distinct closure over
 * `profilesLichHome` (so the two blocks don't tangle their state).
 */
function lichUpWithProfile(cwd: string, profile: string): ReturnType<typeof runLich> {
  return runLich(["up", profile], {
    cwd,
    env: { LICH_HOME: profilesLichHome! },
    timeout: 240_000,
  });
}

/** `lich down` against the per-block LICH_HOME. */
function lichDownProfiles(cwd: string): ReturnType<typeof runLich> {
  return runLich(["down"], {
    cwd,
    env: { LICH_HOME: profilesLichHome! },
    timeout: 120_000,
  });
}

/**
 * Read state.json for a worktree under `profilesLichHome`. Same shape as
 * the top-of-file `readStateForWorktree` but pointed at the per-block
 * registry. We avoid factoring the two readers into one to keep each
 * describe's LICH_HOME usage explicit (and to avoid an unrelated future
 * refactor breaking the sentinel block's assertions).
 */
function readProfileStateForWorktree(
  worktreePath: string,
): {
  stack_id: string;
  status: string;
  active_profile?: string;
  services: Array<{
    name: string;
    state: string;
    allocated_ports?: Record<string, number>;
  }>;
} | null {
  const stacksRoot = join(profilesLichHome!, "stacks");
  if (!existsSync(stacksRoot)) return null;

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
        active_profile?: string;
        services: Array<{
          name: string;
          state: string;
          allocated_ports?: Record<string, number>;
        }>;
      };
      // Same realpath-tolerant suffix match the sentinel reader uses
      // (macOS routes tmpdirs through /private/var/folders).
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

describe("parallel stacks with profiles (Plan 3 Task 26)", () => {
  // Setup runs as a regular `beforeAll` here (rather than the
  // `it("(setup) ...")` pattern used by some Plan 3 e2e files) because the
  // sentinel block in this same file uses beforeAll/afterAll already —
  // staying consistent within the file. The block-level operations
  // (mkdtemp + copyExampleToTmpdir) are sub-second; Bun's 5s default hook
  // timeout is plenty.
  beforeAll(() => {
    profilesLichHome = mkdtempSync(
      join(tmpdir(), "lich-e2e-parallel-profiles-home-"),
    );

    // install: true — same rationale as the sentinel block above (apps/web
    // runs `next dev` which needs `next` in node_modules/.bin).
    profilesStackA = copyExampleToTmpdir("dogfood-stack", {
      prefix: "lich-e2e-profiles-dogfood-a-",
      install: true,
    });
    profilesStackB = copyExampleToTmpdir("dogfood-stack", {
      prefix: "lich-e2e-profiles-dogfood-b-",
      install: true,
    });
  });

  afterAll(async () => {
    // Best-effort: tear down whichever stacks are still up. We swallow
    // failures here but log so a leak surfaces in CI output.
    for (const stack of [profilesStackA, profilesStackB]) {
      if (!stack) continue;
      try {
        lichDownProfiles(stack.path);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `afterAll (profiles) lich down failed for ${stack.path}:`,
          err,
        );
      }
      if (stack.proc && !stack.proc.killed) {
        try {
          stack.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }

    await new Promise<void>((r) => setTimeout(r, 1500));

    for (const stack of [profilesStackA, profilesStackB]) {
      if (!stack) continue;
      try {
        stack.cleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `afterAll (profiles) cleanup failed for ${stack.path}:`,
          err,
        );
      }
    }
    profilesStackA = null;
    profilesStackB = null;

    if (profilesLichHome) {
      try {
        rmSync(profilesLichHome, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `afterAll (profiles) lichHome cleanup failed:`,
          err,
        );
      }
      profilesLichHome = null;
    }
  });

  it(
    "two parallel stacks with different profiles coexist",
    async () => {
      const a = profilesStackA!;
      const b = profilesStackB!;

      // Progress logger — same shape as the sentinel block above. Each
      // `lich up` here brings up the full dogfood stack (postgres + api +
      // web + tunnel_demo); the profile only changes WHICH lifecycle
      // hooks resolve to which env (and, for B, whether after_up succeeds).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- Bring A up under `dev` (default profile) -------------------
      // A is the clean happy-path side — dev's after_up resolves
      // $DATABASE_URL against the local postgres host port, migrations +
      // seed succeed, status:up.
      step("lich up dev for A (postgres pull + boot ~5-10s)");
      const upA = lichUpWithProfile(a.path, "dev");
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up dev for A exited ${upA.exitCode}\n--- stdout ---\n${upA.stdout}\n--- stderr ---\n${upA.stderr}`,
        );
      }
      const stateA1 = readProfileStateForWorktree(a.path);
      expect(stateA1, "state.json for A should exist after up").not.toBeNull();
      expect(stateA1!.status).toBe("up");
      // The new contract under test: the snapshot records the active
      // profile so downstream consumers (stacks listing, dashboard,
      // re-resolved down) know which profile is live.
      expect(stateA1!.active_profile).toBe("dev");
      step(`A up under dev (stack_id=${stateA1!.stack_id})`);

      // ---- Bring B up under `dev:env-override` ------------------------
      // The override profile inherits dev's services/owned list +
      // lifecycle via `extends: dev`, then overrides $DATABASE_URL to the
      // non-resolving `db.test.example.com`. All services come up
      // (postgres comes up under a per-stack compose project so it
      // doesn't collide with A's container). Inherited after_up runs
      // and the psql migration/seed steps fail DNS resolution, aborting
      // after_up. Per up.ts:960-973, the stack is marked status:failed
      // but owned services + compose containers are NOT torn down (they
      // were ready BEFORE after_up tried to seed). exitCode is 1.
      step("lich up dev:env-override for B (after_up will fail; expected)");
      const upB = lichUpWithProfile(b.path, "dev:env-override");
      // We deliberately do NOT throw on non-zero — B's after_up is
      // expected to fail (the override URL is intentionally bogus). We
      // assert the failure shape below.
      const stateB1 = readProfileStateForWorktree(b.path);
      expect(stateB1, "state.json for B should exist after up").not.toBeNull();
      // status:failed is the predicted shape — after_up's `psql` step
      // fails DNS. If a future change either (a) tears down services on
      // after_up failure (giving status:stopped) or (b) makes lich
      // succeed despite the failure (giving status:up), this assertion
      // catches it and the test author can decide which is correct.
      expect(
        stateB1!.status,
        `B should be failed after dev:env-override's after_up errors; saw status=${stateB1!.status}, upB.exitCode=${upB.exitCode}\nstdout:\n${upB.stdout}\nstderr:\n${upB.stderr}`,
      ).toBe("failed");
      expect(stateB1!.active_profile).toBe("dev:env-override");
      // Sanity: exitCode reflects the after_up failure.
      expect(upB.exitCode).not.toBe(0);
      step(`B failed at after_up but recorded active_profile=dev:env-override (stack_id=${stateB1!.stack_id})`);

      // A still up after B's up — same cross-stack-non-interference
      // sentinel as the original block, only re-asserted because profile
      // resolution touches the same snapshot machinery that could
      // accidentally clobber across stacks.
      const stateA2 = readProfileStateForWorktree(a.path);
      expect(stateA2!.status).toBe("up");
      expect(stateA2!.active_profile).toBe("dev");

      // ---- Sentinel #1: distinct stack_ids + no port overlap ----------
      // Different basenames → different worktree paths → different hashes
      // → different stack_ids. The load-bearing isolation assertion for
      // profile-aware parallel stacks: even though both stacks bring up
      // the same shape of services under closely related profiles, they
      // live under distinct stack_ids with distinct docker projects
      // (lich's compose project name includes the worktree hash) and the
      // registry must not have collapsed them.
      expect(stateA2!.stack_id).not.toBe(stateB1!.stack_id);

      const portsA = collectAllocatedPorts(stateA2!);
      const portsB = collectAllocatedPorts(stateB1!);
      expect(portsA.length, "A should have allocated ports").toBeGreaterThan(0);
      expect(portsB.length, "B should have allocated ports").toBeGreaterThan(0);
      const overlap = portsA.filter((p) => portsB.includes(p));
      expect(
        overlap,
        `ports must not overlap; saw A=${JSON.stringify(portsA)} B=${JSON.stringify(portsB)}`,
      ).toEqual([]);

      // ---- Sentinel #2: `lich stacks --json` lists BOTH with their
      //      respective profiles --------------------------------------
      // The registry serializer reads each snapshot and emits
      // `active_profile` on the wire (Plan 3 Task 27 polish, LEV-401).
      // Reading via the registry — not the on-disk snapshot — proves the
      // entire snapshot → stacks --json chain preserves the field for
      // every parallel stack independently AND correctly distinguishes
      // them by their active profile name.
      step("lich stacks --json (against shared profiles LICH_HOME)");
      const stacks = runLich(["stacks", "--json"], {
        cwd: profilesLichHome!,
        env: { LICH_HOME: profilesLichHome! },
      });
      expect(stacks.exitCode).toBe(0);
      const stacksJson = JSON.parse(stacks.stdout) as Array<{
        stack_id: string;
        worktree_name: string;
        status: string;
        active_profile?: string;
      }>;
      expect(stacksJson.length).toBeGreaterThanOrEqual(2);

      const rowA = stacksJson.find((r) => r.stack_id === stateA2!.stack_id);
      const rowB = stacksJson.find((r) => r.stack_id === stateB1!.stack_id);
      expect(
        rowA,
        `lich stacks --json missing row for A (stack_id=${stateA2!.stack_id}); got ${JSON.stringify(stacksJson)}`,
      ).toBeDefined();
      expect(
        rowB,
        `lich stacks --json missing row for B (stack_id=${stateB1!.stack_id}); got ${JSON.stringify(stacksJson)}`,
      ).toBeDefined();
      // The crux of "two parallel stacks with different profiles coexist":
      // each row carries ITS profile, not the other's. If the registry
      // ever cross-wired profile names (a refactor risk), this fires.
      expect(rowA!.active_profile).toBe("dev");
      expect(rowB!.active_profile).toBe("dev:env-override");
      expect(rowA!.status).toBe("up");
      expect(rowB!.status).toBe("failed");

      // ---- lich down both (cleanup; afterAll is a safety net) ---------
      // Both stacks must tear down cleanly even though B's state is
      // `failed`. `lich down` only no-ops on status:stopped (per
      // down.ts:186), so a failed stack still runs the full teardown.
      // The down.ts:362-372 path also re-resolves the active profile
      // from the snapshot so any profile-scoped before_down entries
      // execute (none in dogfood today, but the wiring is exercised).
      step("lich down A");
      const downA = lichDownProfiles(a.path);
      if (downA.exitCode !== 0) {
        throw new Error(
          `lich down A exited ${downA.exitCode}\n--- stdout ---\n${downA.stdout}\n--- stderr ---\n${downA.stderr}`,
        );
      }
      const stateA3 = readProfileStateForWorktree(a.path);
      expect(stateA3!.status).toBe("stopped");
      // active_profile is preserved across down (the field stays on the
      // snapshot so `lich stacks` and the future dashboard can show
      // "stopped under <profile>").
      expect(stateA3!.active_profile).toBe("dev");

      step("lich down B (from failed state)");
      const downB = lichDownProfiles(b.path);
      if (downB.exitCode !== 0) {
        throw new Error(
          `lich down B exited ${downB.exitCode}\n--- stdout ---\n${downB.stdout}\n--- stderr ---\n${downB.stderr}`,
        );
      }
      const stateB3 = readProfileStateForWorktree(b.path);
      expect(stateB3!.status).toBe("stopped");
      expect(stateB3!.active_profile).toBe("dev:env-override");
    },
    // 5-minute timeout — two full stack starts plus assertions. Same
    // budget as the sentinel block.
    300_000,
  );
});

// Reference spawnLich so the import isn't tree-shaken — the helper exists
// for the streaming-up shape future tests may want, but the sentinel uses
// the synchronous `lich up` path (which itself returns once ready).
void spawnLich;
