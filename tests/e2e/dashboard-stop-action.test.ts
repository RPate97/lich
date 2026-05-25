/**
 * Dashboard `POST /api/stacks/:id/stop` end-to-end — Plan 5 Task 27 (LEV-429).
 *
 * Sibling to `dashboard-stack-detail.test.ts` (read) and the unit tests in
 * `packages/lich/tests/unit/daemon/dashboard/actions.test.ts` (spawn shape).
 * Those cover the projection wire format and the subprocess machinery
 * respectively; THIS test pins the contract that an end-to-end POST to
 * the action endpoint actually tears the stack down in the real world:
 * containers gone, owned PIDs dead, allocated ports released, state.json
 * transitioned to `stopped`.
 *
 * Why this test is separate from the GET-side dashboard tests:
 *
 *   - The GET tests prove the dashboard can *describe* a running stack.
 *     The action test proves the dashboard can *control* one. Both fail
 *     modes are very different — a regression in the projection layer
 *     (stacks-view.ts) won't surface here, and a regression in the
 *     action handler (server.ts's `handleActionRequest` or actions.ts's
 *     `runLichAction`) won't surface in the GET tests. Keeping them in
 *     distinct files makes the failure attribution obvious from the
 *     test name alone.
 *
 *   - `down.test.ts` already exercises the underlying `lich down` CLI
 *     path. The action handler is a thin shell-out wrapper around that
 *     same command, but the test specifically verifies the daemon's
 *     HTTP-triggered codepath: the dashboard server receives the POST,
 *     looks up the worktree from state.json, spawns the lich subprocess
 *     in that cwd, and returns the structured result. A regression in
 *     any of those steps wouldn't be caught by `down.test.ts`.
 *
 * Coverage of this test:
 *
 *   1. `lich up --no-browser` against a tmpdir copy of the dogfood-stack
 *      brings the stack up AND triggers the daemon auto-start (LEV-411).
 *   2. Discover the stack id via `<LICH_HOME>/stacks/<id>/` directory
 *      listing — same single-entry trick `basic-up.test.ts` uses.
 *   3. Capture the allocated ports from state.json BEFORE stopping, so
 *      the post-stop port-listening assertion has concrete numbers to
 *      probe.
 *   4. `POST /api/stacks/<id>/stop` (via the extended `fetchDashboardJson`
 *      with `method: "POST"`) returns HTTP 200 with `{ ok, exitCode,
 *      stdout, stderr }` matching the {@link ActionResult} contract from
 *      `packages/lich/src/daemon/dashboard/actions.ts`. We assert
 *      `ok: true` AND `exitCode: 0` rather than either-or: both must
 *      hold for a clean stop (the `ok` field IS derived from
 *      `exitCode === 0` in the production code, but pinning both catches
 *      a regression where one drifts from the other).
 *   5. Poll state.json for `status: "stopped"` within 60s. The CLI returns
 *      to the daemon as soon as the down completes; the state transition
 *      is part of the same call, so it should be visible essentially
 *      immediately, but we allow generous slop for slow file syncs.
 *   6. Probe one of the captured ports with a TCP connect — the connection
 *      MUST be refused (the listener is gone). Using TCP rather than
 *      `isPortFree`'s bind probe (which `down.test.ts` uses) more directly
 *      validates the spec's contract: "after stop, nothing on those ports
 *      will answer." This is the user-visible behavior; whether a NEW
 *      process *could* bind is a finer-grained property the down-test
 *      already covers.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (the repo's source is never touched).
 *   - LICH_HOME pointed at a per-test tmp directory — the daemon, its
 *     PID file, its URL file, and the stack's state.json all live there.
 *   - lich + lich-daemon binaries built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - Defense in depth: `lich down` + `lich nuke --yes` run in `afterEach`
 *     even on a clean happy-path exit (the action stop itself should
 *     have already done the work, but afterEach ensures the daemon is
 *     reaped so the next test gets a fresh per-LICH_HOME daemon spawn).
 *   - Both tmpdirs recursively removed.
 *
 * Runtime budget: ~5 minutes (mostly the cold-supabase pull on first
 * run). The POST itself is sub-second once `lich down` completes
 * internally — actions.ts wraps the subprocess and captures output, no
 * extra round-trips required.
 *
 * STATUS (2026-05-24): This test fails pending LEV-414, which wires the
 * dashboard server into the daemon's main loop. Until that lands, the
 * daemon starts but never binds the dashboard port, so `daemon.url`
 * either doesn't get written (current daemon code) or points at a
 * placeholder that doesn't serve `/api/stacks/:id/stop`. Both failure
 * modes are diagnostic enough to confirm the test is correct and the
 * wiring is what's missing — committed as a TDD red test that turns
 * green when LEV-414 lands.
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
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { readStateJson, waitForStackStatus } from "./helpers/state.js";
import { waitForDaemonRunning } from "./helpers/daemon.js";
import { fetchDashboardJson } from "./helpers/dashboard-fetch.js";

// ---------------------------------------------------------------------------
// Wire-format type for the action response. Mirrors
// `packages/lich/src/daemon/dashboard/actions.ts`'s `ActionResult` interface.
// Duplicated locally (NOT imported) per testing-standards §"E2e tests spawn
// the real binary": the e2e suite stays out-of-process. If the response
// shape ever drifts from this definition, the test fails — that's the
// point of a separate type definition.
// ---------------------------------------------------------------------------

interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Build the binaries up front. Same pattern as basic-up.test.ts and
// daemon-auto-shutdown.test.ts — fail loudly if a build is missing. We
// need BOTH `lich` (the CLI the daemon shells out to in its action
// handler) AND `lich-daemon` (the daemon binary itself); without either,
// the action endpoint can't function end to end.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");
const lichDaemonBinary = resolve(repoRoot, "packages/lich/dist/lich-daemon");

beforeAll(() => {
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
// and the real ~/.lich never gets touched. Matches the shape used by
// basic-up.test.ts / dashboard-stack-detail.test.ts.
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
  // immediately and `lich up` fails before state.json reaches "up".
  // Same justification as basic-up.test.ts (LEV-313).
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-dashboard-stop-action-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Belt-and-braces teardown. Best-effort lich down (the action under test
 * should have already stopped the stack on the happy path, but a mid-test
 * failure may leave services running), then lich nuke --yes (kills the
 * daemon process and any orphan owned processes), then tmpdir cleanup.
 * Every step is a separate try/catch so one failure doesn't block the
 * others.
 */
function teardownFixture(fix: Fixture): void {
  // LEV-465: timeouts tightened from 120s/60s → 20s. afterEach is a
  // fast cleanup path; vitest's hookTimeout caps at 60s. `lich nuke
  // --yes` was diagnosed at sub-200ms even when killing a live daemon.
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  // nuke --yes: the daemon process is per-machine and per-LICH_HOME; if we
  // leave it alive, the daemon.pid/daemon.url under our tmp LICH_HOME stay
  // valid and the next test's `lich up` would short-circuit on the
  // "already running" branch — even though the OTHER test wants a fresh
  // daemon spawn. Nuke kills the daemon AND clears its files.
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
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
 * basic-up.test.ts and dashboard-stack-detail.test.ts's helper of the same
 * name. The test only ever brings one stack up, so the single-entry
 * assumption holds.
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

/**
 * Try a TCP connect to 127.0.0.1:<port>. Resolves true iff the connect
 * was REFUSED (ECONNREFUSED — no listener bound) within `timeoutMs`.
 * Resolves false on any other outcome: successful connect (listener
 * still up), timeout (port might be filtered but the listener could
 * be hung), or other error.
 *
 * Deliberately distinct from `down.test.ts`'s `isPortFree` bind probe:
 * the bind probe asks "could a *new* process take this port?" The
 * connect probe asks "does anything answer on this port right now?" —
 * which is the user-visible behavior the dashboard stop action promises
 * to deliver. A flaky environment where the kernel is slow to release
 * the port from TIME_WAIT could fail a bind probe while still correctly
 * passing the connect probe; we want the connect probe here because
 * that's the contract being verified.
 */
function isPortRefused(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (refused: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
      resolve(refused);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(err.code === "ECONNREFUSED");
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard POST /api/stacks/:id/stop tears down the stack", () => {
  it(
    "stop action returns ok:true and the stack transitions to stopped with ports refused",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — the heavy step is `lich up` (cold supabase
      // pull) which can be silent for ~30-90s on first run. Surface what
      // phase the test is in so a hang is obvious. Matches the pattern from
      // basic-up.test.ts, daemon-auto-shutdown.test.ts, and the other
      // dashboard tests.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser -----------------------------------------
      // --no-browser keeps CI/headless hosts from trying to spawn Chrome
      // (the daemon would still open it without the flag — LEV-411). The
      // dashboard server starts regardless, which is what we need.
      step("lich up --no-browser (cold supabase pull ~30-90s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface the failure cause immediately so a regression is one
        // line of output, not a debugging session.
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- wait for state.json: status:up -------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      step(`stack ${stackId} up`);

      // ---- capture allocated ports BEFORE the stop ----------------------
      // We need concrete port numbers to probe with `isPortRefused` post-
      // stop. After the stack stops, state.json may zero out / omit ports,
      // so we read them while the stack is still up. The dogfood-stack
      // declares four owned services and every one is expected to have
      // at least one allocated port (dashboard-stack-detail.test.ts
      // already asserts this; we rely on it here).
      const portsBefore: number[] = [];
      for (const svc of snap.services) {
        if (svc.allocated_ports) {
          for (const port of Object.values(svc.allocated_ports)) {
            portsBefore.push(port);
          }
        }
      }
      expect(
        portsBefore.length,
        `expected dogfood-stack to allocate at least one port; got 0`,
      ).toBeGreaterThan(0);
      step(`captured ${portsBefore.length} allocated port(s) pre-stop`);

      // ---- wait for daemon ----------------------------------------------
      // After `lich up` exits successfully, the daemon should already be
      // running (the auto-start hook fires before `up` returns — see
      // up.ts's LEV-411 block). 10s is plenty: on the cold path the
      // daemon takes ~500ms to write its URL file.
      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 10_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      // ---- POST /api/stacks/:id/stop ------------------------------------
      // The action endpoint shells out to `lich down` in the worktree
      // and returns a structured ActionResult. Generous 3-minute timeout
      // accommodates supabase teardown (the same budget down.test.ts
      // uses for `lich down`). The helper throws on non-2xx, so a 404
      // (stack not found) or 405 (wrong method — e.g. a regression that
      // routes the stop verb to a GET handler) immediately surfaces here.
      step(`POSTing /api/stacks/${stackId}/stop`);
      const result = await fetchDashboardJson<ActionResult>(
        lichHome,
        `/api/stacks/${stackId}/stop`,
        { method: "POST", timeoutMs: 180_000 },
      );

      // ok: true AND exitCode: 0. Both: a regression where the projection
      // accidentally diverged these (e.g. someone hard-coded `ok: true`)
      // would still satisfy the loose either-or check; pinning both
      // catches it. The production contract in actions.ts is
      // `ok = (exitCode === 0)` — that invariant holds here too.
      expect(result.ok, `action returned ok=${result.ok}, stderr=${result.stderr}`).toBe(true);
      expect(result.exitCode).toBe(0);
      // stdout/stderr fields are part of the ActionResult contract — even
      // when empty, they MUST be strings (not undefined). A regression
      // where the spawn handler dropped the field (e.g. returning
      // `undefined` instead of `""` on no-output) would fail this and
      // break the dashboard's result-panel rendering.
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
      step("stop action exit 0");

      // ---- wait for state.json: status:stopped --------------------------
      // The CLI's down command writes `status: stopped` to state.json
      // before returning; the daemon's action handler awaits that
      // subprocess. So by the time the POST returns, state.json should
      // already be at `stopped` — but allow generous slop for slow fs
      // syncs on CI. The 60s budget matches the plan's acceptance
      // criterion verbatim.
      step("waiting for state.json status:stopped");
      const stoppedSnap = await waitForStackStatus(
        lichHome,
        stackId!,
        "stopped",
        { timeoutMs: 60_000 },
      );
      expect(stoppedSnap.status).toBe("stopped");
      step("state.json shows status:stopped");

      // ---- assert allocated ports are no longer listening ---------------
      // Try a TCP connect to each pre-stop port; ECONNREFUSED proves
      // the listener is gone. Done sequentially rather than in parallel
      // so a failure pinpoints WHICH port still answers. The 2s per-port
      // timeout is conservative — a refused connect resolves in
      // sub-millisecond on a local host. Hitting the timeout itself
      // would indicate "something on the port but not responsive,"
      // which we treat as a failure (the spec says nothing should
      // answer).
      for (const port of portsBefore) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await isPortRefused(port);
        expect(
          refused,
          `expected port ${port} to refuse connections after stop, but it did not (still listening or filtered)`,
        ).toBe(true);
      }
      step(`all ${portsBefore.length} port(s) refuse connections post-stop`);

      // Defense-in-depth: re-read state.json directly (not via
      // waitForStackStatus, which would just succeed immediately given
      // we're already at `stopped`). Confirms the snapshot is still
      // there and parseable — a regression where `down` accidentally
      // deleted the state directory entirely would manifest as
      // `readStateJson` returning null here.
      const finalSnap = readStateJson(lichHome, stackId!);
      expect(finalSnap).not.toBeNull();
      expect(finalSnap!.status).toBe("stopped");

      step("all stop-action assertions passed");
    },
    // Per-test override: 5 minutes — same shape as basic-up,
    // dashboard-stack-detail, and the other dogfood-stack-based tests.
    // The cold supabase pull on first run is the bottleneck; subsequent
    // runs hit warm images and complete in under a minute. The action
    // POST itself is fast once the up completes.
    300_000,
  );
});
