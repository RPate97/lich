/**
 * `lich restart` against the dogfood-stack — Plan 5 Task 19 (LEV-421).
 *
 * Verifies the whole-stack restart contract end-to-end:
 *
 *   1. `lich up` brings the stack up (api + supabase + web + tunnel_demo).
 *   2. `lich restart` tears the stack down and brings it back up in one
 *      shot — same stack_id, fresh PIDs, services serve traffic again.
 *   3. `lich down` cleans everything up.
 *
 * Per the testing-standards §"For `lich restart`":
 *   - Whole-stack restart: all services stopped then started. New PIDs.
 *   - Selected services / --owned / --compose: out of scope for v1 MVP
 *     (see commands/restart.ts module JSDoc).
 *
 * Per the LEV-421 acceptance criteria: `lich urls` still shows the same
 * stack with new PIDs after restart.
 *
 * Runtime budget: ~10 minutes. A restart is up-down-up; the first up
 * pulls/starts supabase (~30-90s on cold images), down is ~30s, the
 * second up reuses warm images (~30-60s). Even on a slow CI box this
 * lands well inside 10 min.
 *
 * Heavy test; requires docker + supabase CLI v2+ on the host. Without
 * them the first `lich up` will fail loudly with the actual underlying
 * error — same contract as `basic-up.test.ts` (LEV-314).
 */

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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";
import { parseLichUrls } from "./helpers/urls.js";
import { readStateJson, waitForStackStatus } from "./helpers/state.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as basic-up.test.ts — fail loudly
// if the build is missing; the binary IS our code, and a broken build is a
// real bug rather than something to skip past.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

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

// ---------------------------------------------------------------------------
// Per-test fixture — fresh tmpdir + LICH_HOME so nothing leaks between tests
// and the real ~/.lich never gets touched.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127
  // immediately during the post-restart `lich up` and the test fails
  // before any state.json is rewritten. Same justification as
  // basic-up.test.ts (LEV-313).
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-restart-basic-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Belt-and-braces teardown. Best-effort lich down (the test should have
 * cleaned up on the happy path; this catches the failure path where
 * services are still running). Then nuke the LICH_HOME tmpdir and the
 * stack tmpdir.
 */
function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 120_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  // Defensive: nuke covers anything down missed (e.g. partial-up state where
  // services are running but state.json never said "up").
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 60_000,
    });
  } catch {
    /* best-effort */
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

// ---------------------------------------------------------------------------
// Helpers private to this suite
// ---------------------------------------------------------------------------

/**
 * Find the (single) stack id present under `<lichHome>/stacks/`. Mirrors
 * basic-up.test.ts's helper of the same name. Returns null when the
 * directory hasn't been created yet (e.g. `lich up` failed before
 * `state.json` was written).
 */
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

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("lich restart against dogfood-stack", () => {
  it(
    "tears the stack down and brings it back up under the same stack_id",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — restart is the slowest e2e test in the
      // suite (up + down + up), so the user staring at silence for ~5
      // minutes needs something to indicate forward motion.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- ACT 1: lich up ---------------------------------------------
      // Generous timeout: first run pulls supabase images, which can take
      // a couple of minutes cold.
      step("lich up #1 (cold supabase pull ~30-90s)");
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up #1 stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up #1 stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up #1 exit 0");

      // ---- CAPTURE pre-restart state ----------------------------------
      const stackIdBefore = findStackId(lichHome);
      expect(stackIdBefore).not.toBeNull();
      const snapBefore = await waitForStackStatus(
        lichHome,
        stackIdBefore!,
        "up",
        { timeoutMs: 10_000 },
      );
      expect(snapBefore.status).toBe("up");

      // Sanity: api is among the started services. We probe its /health
      // endpoint post-restart, so this is a precondition.
      const apiBefore = snapBefore.services.find((s) => s.name === "api");
      expect(apiBefore?.state).toBe("ready");
      const apiPortBefore = apiBefore?.allocated_ports?.default;
      expect(
        apiPortBefore,
        `expected api to have an allocated port before restart`,
      ).toBeTruthy();

      // Record owned PIDs so we can verify they CHANGE after restart
      // (the "new PIDs" half of the acceptance criteria).
      const pidsBefore = new Map<string, number>();
      for (const svc of snapBefore.services) {
        if (svc.kind === "owned" && typeof svc.pid === "number") {
          pidsBefore.set(svc.name, svc.pid);
        }
      }
      expect(pidsBefore.size).toBeGreaterThan(0);

      // Pre-restart api health probe — confirms the stack is actually
      // serving traffic, not just claiming "ready" in state.json.
      step(`probing api /health pre-restart (port ${apiPortBefore})`);
      await waitForHttp200(`http://127.0.0.1:${apiPortBefore}/health`, {
        timeoutMs: 15_000,
      });

      // ---- ACT 2: lich restart -----------------------------------------
      // Restart is up+down+up so 5+ min timeout — second up benefits
      // from warm images, but supabase migrations still re-run if the
      // dogfood stack declared them in after_up. 6 min budget covers
      // teardown + warm restart on a slow box.
      step("lich restart (down + up; warm supabase ~30-60s)");
      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 360_000,
      });
      if (restartResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich restart stdout:", restartResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich restart stderr:", restartResult.stderr);
      }
      expect(restartResult.exitCode).toBe(0);
      step("lich restart exit 0");

      // ---- ASSERT post-restart -----------------------------------------

      // 1. Same stack_id. Worktree identity is preserved across restart
      //    — the stack directory under ~/.lich/stacks/<id>/ stays the
      //    same. If this regresses, restart is creating a new stack
      //    rather than restarting the existing one, which would leak
      //    state on every restart cycle.
      const stackIdAfter = findStackId(lichHome);
      expect(stackIdAfter).toBe(stackIdBefore);

      // 2. status:up in the new state.json. waitForStackStatus polls
      //    state.json — restart's final write happens at the end of
      //    runUp's "Step 12 + 13" so this should land within seconds
      //    of restart's exit.
      const snapAfter = await waitForStackStatus(
        lichHome,
        stackIdAfter!,
        "up",
        { timeoutMs: 10_000 },
      );
      expect(snapAfter.status).toBe("up");

      // 3. Every service that was up before is up again. The set of
      //    services is the same (no profile switch); their states are
      //    all "ready"; their port assignments survive the restart
      //    (the port allocator's per-stack reservation gets re-claimed
      //    in the second up).
      const namesBefore = snapBefore.services.map((s) => s.name).sort();
      const namesAfter = snapAfter.services.map((s) => s.name).sort();
      expect(namesAfter).toEqual(namesBefore);
      for (const svc of snapAfter.services) {
        expect(
          svc.state,
          `service ${svc.name} did not reach ready after restart`,
        ).toBe("ready");
      }

      // 4. Owned PIDs are NEW. This is the "new PIDs" half of the
      //    acceptance criteria — restart actually killed and re-spawned
      //    the processes rather than no-opping.
      let changedPidCount = 0;
      for (const svc of snapAfter.services) {
        if (svc.kind !== "owned" || typeof svc.pid !== "number") continue;
        const oldPid = pidsBefore.get(svc.name);
        if (oldPid !== undefined) {
          expect(
            svc.pid,
            `service ${svc.name} kept the same PID across restart (was ${oldPid})`,
          ).not.toBe(oldPid);
          changedPidCount++;
        }
      }
      expect(changedPidCount).toBeGreaterThan(0);

      // 5. The stack is actually serving traffic again. Hitting the api's
      //    /health endpoint AFTER restart is the strongest evidence the
      //    stack works — independent of any state.json claim that
      //    services are "ready". Pre-restart port may have been
      //    re-allocated; re-read from the new snapshot.
      const apiAfter = snapAfter.services.find((s) => s.name === "api");
      const apiPortAfter = apiAfter?.allocated_ports?.default;
      expect(
        apiPortAfter,
        `expected api to have an allocated port after restart`,
      ).toBeTruthy();
      step(`probing api /health post-restart (port ${apiPortAfter})`);
      await waitForHttp200(`http://127.0.0.1:${apiPortAfter}/health`, {
        timeoutMs: 30_000,
      });
      const health = await fetch(
        `http://127.0.0.1:${apiPortAfter}/health`,
      ).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok" });

      // 6. `lich urls` lists the stack with the SAME services (independent
      //    sanity check on top of the snapshot assertion above). Per the
      //    acceptance criteria: "urls still shows the same stack with new
      //    PIDs".
      const urlsResult = runLich(["urls"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      expect(Object.keys(urls).sort()).toEqual(
        expect.arrayContaining(["api", "supabase", "web"]),
      );
      step("post-restart assertions complete");

      // ---- ACT 3: lich down (cleanup) ---------------------------------
      // Explicit cleanup in the test body so the assertion-on-down lives
      // here rather than in afterEach's best-effort path. The afterEach
      // also calls down — that's idempotent and a no-op on an already-
      // stopped stack.
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(downResult.exitCode).toBe(0);

      const downSnap = readStateJson(lichHome, stackIdAfter!);
      expect(downSnap?.status).toBe("stopped");
      step("lich down complete; stack stopped");
    },
    // 10-minute per-test budget: cold pull (~90s) + first up (~60s) +
    // restart down (~30s) + restart up warm (~60s) + final down (~30s) +
    // headroom for slow CI. The default 120s is wildly too tight.
    600_000,
  );
});
