/**
 * `lich daemon auto-shutdown` against the dogfood-stack — Plan 5 Task 22 (LEV-424).
 *
 * Verifies the daemon's auto-shutdown contract from spec section 6:
 *
 *   1. `lich up --no-browser` brings up a stack AND the per-machine daemon
 *      (the daemon is auto-spawned by `lich up` if not already alive).
 *   2. The daemon advertises itself via `<LICH_HOME>/daemon.pid` +
 *      `<LICH_HOME>/daemon.url`, both readable by the test.
 *   3. `lich down` tears down the stack. The stack's state transitions to
 *      `stopped`, so it stops counting as "alive" from the daemon's
 *      perspective.
 *   4. The daemon's auto-shutdown loop polls every 10s (default
 *      `shutdownCheckMs`) and exits after 3 consecutive empty ticks
 *      (default `shutdownGraceTicks`) — worst case ~30s from when the
 *      stack stops being alive.
 *   5. On clean shutdown the daemon clears its own PID + URL files
 *      (`cleanupPromise` in `daemon.ts` calls `clearDaemonPid` /
 *      `clearDaemonUrl`).
 *
 * Total time budget for the slow path: ~3-4 minutes
 *   - setup (lich up): ~60-180s (supabase cold-pull dominates)
 *   - lich down: ~15-30s
 *   - daemon auto-shutdown grace: ~30-45s (30s loop + buffer for I/O
 *     + state propagation)
 *
 * Heavy test — requires docker + supabase CLI v2+ on the host. Without
 * those `lich up` fails loudly with the actual underlying error (same
 * contract as basic-up.test.ts; LEV-314).
 *
 * Per the plan: "It's tempting to expose a `--shutdown-timeout-ms` flag
 * on `lich-daemon` for tests to use shorter intervals. RESIST — tests
 * should exercise the real timing." So this test waits the full ~30s
 * grace; no fake timers, no shortened intervals.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one)
 *   - LICH_HOME pointed at a per-test tmp directory so the real ~/.lich
 *     stays untouched (no collisions with the user's own daemon)
 *   - lich binary AND lich-daemon binary both built in `beforeAll`
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in `afterEach` even when the test body
 *     throws (defense in depth — kills any daemon that didn't auto-stop
 *     and any owned processes from a half-up stack)
 *   - tmpdir + LICH_HOME removed in `afterEach`
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
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import {
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "./helpers/daemon.js";

// ---------------------------------------------------------------------------
// Build the binaries up front. Same pattern as basic-up.test.ts: fail loudly
// if a build is missing; the binaries ARE our code and a broken build is a
// real bug, not something to skip past.
//
// Both `lich` AND `lich-daemon` are required: `lich up` shells out to spawn
// `lich-daemon` as a sibling of its own binary (see
// `packages/lich/src/daemon/auto-start.ts`'s `resolveDaemonBinary`). Without
// the daemon binary, `lich up` prints a one-line warning and continues; the
// daemon never starts and the test would see no PID file ever.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");
const lichDaemonBinary = resolve(repoRoot, "packages/lich/dist/lich-daemon");

beforeAll(() => {
  // Always rebuild if either binary is missing. The build script is fast
  // (~150ms each with bun --compile) and idempotent — paying the cost on
  // a stale install is preferable to silently testing against the wrong
  // binary.
  if (!existsSync(lichBinary)) {
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
  }
  if (!existsSync(lichDaemonBinary)) {
    const build = spawnSync("bun", ["run", "build:daemon"], {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
      timeout: 120_000,
    });
    if (build.status !== 0) {
      throw new Error(
        `failed to build lich-daemon binary (exit ${build.status}); cannot run e2e tests`,
      );
    }
    if (!existsSync(lichDaemonBinary)) {
      throw new Error(
        `lich-daemon build reported success but ${lichDaemonBinary} does not exist`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Per-test fixture — fresh tmpdir + LICH_HOME so nothing leaks between tests
// and the real ~/.lich never gets touched. Mirrors the pattern from
// basic-up.test.ts and restart-basic.test.ts.
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
  // immediately and `lich up` fails before any state.json is written.
  // See LEV-313.
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-daemon-auto-shutdown-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Defensive teardown. The happy path of the test ends with the daemon
 * already gone, but the failure paths (assertion fails mid-test, lich up
 * fails) may leave a daemon + owned services running. `lich nuke --yes`
 * is the sledgehammer: kills the daemon via SIGTERM/SIGKILL, tears down
 * every recorded stack, clears state.
 */
function teardownFixture(fix: Fixture): void {
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 120_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich nuke failed for ${fix.stackPath}:`, err);
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
// The test
// ---------------------------------------------------------------------------

describe("lich daemon auto-shutdown", () => {
  it(
    "daemon exits within ~45s after the last stack stops, clearing PID + URL files",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger so the user staring at silence for several
      // minutes sees forward motion (matches the pattern from basic-up.test.ts
      // and restart-basic.test.ts).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- ACT 1: lich up --no-browser -------------------------------------
      // `--no-browser` is critical so CI doesn't try to spawn Chrome. The
      // up timeout is generous because supabase cold-pull dominates the
      // first run.
      step("lich up --no-browser (supabase cold-pull ~30-90s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- ASSERT: daemon advertises itself -------------------------------
      // The `--no-browser` flag does NOT suppress the daemon — only the
      // browser-open call. We expect both files (daemon.pid + daemon.url)
      // to be present and the recorded PID to be alive within seconds of
      // `lich up` returning. Use a generous 30s window for cold-start
      // Bun + Bun.serve bind on slow CI.
      step("waiting for daemon PID + URL files");
      const daemonInfo = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      expect(daemonInfo.pid).toBeGreaterThan(0);
      expect(daemonInfo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      step(`daemon alive: pid=${daemonInfo.pid} url=${daemonInfo.url}`);

      // Capture the daemon's pid so the post-down assertion can prove it
      // actually exited (via the dead-PID signal-0 check inside
      // `waitForDaemonStopped`).
      const daemonPid = daemonInfo.pid;

      // ---- ACT 2: lich down ----------------------------------------------
      // After down returns, the stack's state.json transitions to
      // `status: stopped`. The daemon's auto-shutdown loop, polling every
      // 10s with K=3 consecutive empty ticks, will fire ~30s later.
      step("lich down (stack teardown, ~15-30s)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");

      // ---- WAIT: daemon auto-shutdown ------------------------------------
      // Worst case: lich down completes just AFTER a daemon tick ran with
      // alive=1, so the daemon needs 3 more full intervals (~30s) to count
      // 3 consecutive empty ticks and fire shutdown. The 45s budget gives
      // a 15s buffer for I/O + state propagation + cleanup (watcher stop +
      // PID file removal). 60s is the hard ceiling we'll wait — beyond
      // that something is genuinely wrong with the auto-shutdown loop.
      step("waiting for daemon auto-shutdown (30s grace + buffer)");
      const t1 = Date.now();
      await waitForDaemonStopped(lichHome, { timeoutMs: 60_000 });
      const shutdownElapsedMs = Date.now() - t1;
      step(`daemon exited after ${(shutdownElapsedMs / 1000).toFixed(1)}s`);

      // Sanity: the elapsed wait should be ≥ ~10s (one tick window) and
      // ≤ 45s (the spec's grace + buffer). A sub-second exit would mean
      // the daemon shut down before the auto-shutdown loop even fired
      // (a bug — likely a crash or a signal we didn't send). A >45s wait
      // is OK in principle but signals the auto-shutdown timing is
      // drifting from spec — flag for investigation.
      //
      // We use a 45s soft assertion (the test passed if we reached this
      // point inside 60s) and surface the actual elapsed time in the log.
      // The 45s value is the plan's own "30s grace + 15s buffer for I/O
      // + state propagation" budget.
      expect(
        shutdownElapsedMs,
        `daemon took ${(shutdownElapsedMs / 1000).toFixed(1)}s to auto-shutdown; expected ≤ 45s (30s grace + 15s buffer)`,
      ).toBeLessThanOrEqual(45_000);

      // ---- ASSERT: PID + URL files cleared -------------------------------
      // The daemon's clean-shutdown path runs `clearDaemonPid` +
      // `clearDaemonUrl` before resolving (see `runCleanup` in
      // `daemon.ts`). Both files must be absent after a clean exit. If
      // either persists, the next `lich up` would either bail (live PID
      // check) or trust a stale URL — both are user-visible bugs.
      const pidPath = join(lichHome, "daemon.pid");
      const urlPath = join(lichHome, "daemon.url");
      expect(
        existsSync(pidPath),
        `expected daemon.pid to be cleared after auto-shutdown; found at ${pidPath}`,
      ).toBe(false);
      expect(
        existsSync(urlPath),
        `expected daemon.url to be cleared after auto-shutdown; found at ${urlPath}`,
      ).toBe(false);

      // ---- ASSERT: daemon process is actually dead -----------------------
      // Belt-and-braces: signal 0 to the captured PID should fail with
      // ESRCH (process gone). If it's still alive, something other than
      // the auto-shutdown cleared the PID file (a race with afterEach's
      // nuke? a third party?) and the test would mask a real bug.
      let isStillAlive = false;
      try {
        process.kill(daemonPid, 0);
        isStillAlive = true;
      } catch (err) {
        // ESRCH = process gone; EPERM = exists but we lack permission
        // (counts as alive per `isDaemonAlive` semantics, but should be
        // impossible here since we spawned it as our own user).
        const code = (err as NodeJS.ErrnoException).code;
        isStillAlive = code === "EPERM";
      }
      expect(
        isStillAlive,
        `daemon process pid=${daemonPid} is still alive after PID file was cleared`,
      ).toBe(false);

      step("auto-shutdown verified end-to-end");
    },
    // 10-minute per-test budget. Breakdown:
    //   - lich up (supabase cold-pull): up to 4 min
    //   - daemon-running assertion: <30s
    //   - lich down: ~30s
    //   - daemon auto-shutdown wait: up to 60s
    //   - file/PID assertions: <1s
    //   - headroom for slow CI
    // The default 120s is far too tight; 10 min covers the worst case.
    600_000,
  );
});
