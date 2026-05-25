/**
 * Dashboard renders a failed service end-to-end — Plan 5 Task 26 (LEV-428).
 *
 * Sibling to `dashboard-stack-list.test.ts` and `dashboard-stack-detail.test.ts`.
 * Those tests prove the happy-path projection (stack `up`, services `ready`,
 * routing entries populated). THIS test proves the failure-path projection:
 * a stack whose `lich up` fired the per-level failure path (Plan 4) appears
 * in the dashboard's `/api/stacks/:id` response with the failed service
 * carrying its `failure_reason` + `failure_log_tail` verbatim from
 * `state.json`. Without this coverage a regression in `stacks-view.ts`'s
 * pass-through of those fields (e.g. accidentally stripping them in the
 * projection, or dropping them when `state !== "failed"` defensively) would
 * land silently — the SPA would render a failed service as a name with no
 * triage context.
 *
 * Coverage of this test:
 *
 *   1. Copy the dogfood-stack to a tmpdir, overwrite its `lich.yaml` with
 *      `examples/dogfood-stack/lich-failing-variant.yaml` — a minimal one-
 *      service variant whose `cmd` exits non-zero before `ready_when` can
 *      ever match. Same overwrite trick `failure-fail-when.test.ts` and
 *      `failure-process-exit.test.ts` use to keep the failure path under
 *      seconds (the real dogfood `dev` profile would force a supabase cold
 *      pull just to reach the failure assertion).
 *
 *   2. Isolated LICH_HOME — the daemon's PID/URL files and the stack's
 *      `state.json` all live under a per-test tmpdir; the user's real
 *      `~/.lich` is never touched. Required because the daemon binds an
 *      ephemeral dashboard port and a fixed proxy port — without
 *      isolation the test could race the user's own daemon.
 *
 *   3. `lich up --no-browser` — expected to exit non-zero (Plan 4's per-
 *      level failure path returns code 1 from `runUp`, see
 *      `commands/up.ts:887`). The cmd `echo "failing"; exit 1` is observed
 *      by `up.ts`'s ProcessExitWatcher and persisted to `state.json` as
 *      `services[0].state: "failed"` with `failure_reason` (the formatter's
 *      "exited with code 1 during startup" string) and `failure_log_tail`
 *      (the captured `failing` line, possibly empty if the shell folded
 *      the echo into the exit syscall).
 *
 *   4. Daemon does NOT auto-start on the failure path — `up.ts`'s
 *      `ensureDaemonRunning` call sits AFTER `state.status = "up"` is
 *      written (commands/up.ts:1024-1054), so the per-level failure
 *      branch (line 955) returns before the daemon trigger fires. The
 *      test therefore spawns `dist/lich-daemon` manually with the same
 *      LICH_HOME env so the daemon picks up the failed stack's
 *      `state.json` via its filesystem watcher. The daemon's own
 *      auto-shutdown counter doesn't count `failed` stacks as "alive"
 *      (see `ALIVE_STATUSES` in `daemon/daemon.ts`), so this daemon will
 *      exit ~30s after spawn — that's fine, the test's dashboard fetch
 *      completes in milliseconds.
 *
 *   5. `GET /api/stacks/<id>` via `fetchDashboardJson`:
 *      - the stack's `status` is `"failed"` (mirrors `state.json`)
 *      - `services[0].name === "broken"` (from the fixture yaml)
 *      - `services[0].state === "failed"` (Plan 4 ProcessExitWatcher
 *        + `markFailed` flipped it from `starting` to `failed`)
 *      - `services[0].failure_reason` defined and contains "code 1"
 *        (formatter renders the exit code into the reason string;
 *        asserting on "code 1" rather than the exact prose lets future
 *        copy tweaks land without breaking the test, while a regression
 *        that lost the exit code surfaces)
 *      - `services[0].failure_log_tail` is an array (possibly empty per
 *        the shell-flush-timing caveat from `failure-process-exit.test.ts`)
 *
 * Negative-path assertions deliberately omitted:
 *
 *   - The 404 case (unknown stack id) is already covered by
 *     `dashboard-stack-detail.test.ts`. Duplicating it here would dilute
 *     the test's signal — when this test fails, it should mean a
 *     regression in the failure projection specifically, not a re-test
 *     of the 404 dispatch.
 *   - The UI render (red badge, expandable log tail) is NOT tested here.
 *     Plan 5 explicitly defers UI rendering to a manual smoke test (per
 *     Task 26's implementation notes: "It does NOT verify the UI render
 *     — that's a manual smoke test; the v0 dashboard didn't unit-test
 *     its React components either"). The wire format IS the contract;
 *     the SPA's render is downstream of the JSON shape this test pins.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (the repo's source is never touched).
 *   - LICH_HOME pointed at a per-test tmp directory.
 *   - lich + lich-daemon binaries built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in `afterEach` even when the test body
 *     throws. Nuke kills the daemon (per LEV-420 / Plan 5 Task 18) so
 *     subsequent tests in the suite don't observe the stale daemon. The
 *     `cmd: echo failing; exit 1` service has already exited on its own
 *     so there's nothing to reap on the stack side — but `nuke` still
 *     clears state.json + tears the daemon down, which is what we need.
 *   - Tmpdir + LICH_HOME removed recursively.
 *
 * Runtime budget: ~30s (no supabase, no compose, no docker). The cmd
 * exits in milliseconds; the daemon's cold-spawn is ~500ms; the dashboard
 * fetch is sub-ms. Most of the budget is binary build + safety margin.
 *
 * STATUS: this test depends on LEV-414 (daemon wires the real dashboard
 * server) + LEV-417 (stacks-view passes through failure_reason +
 * failure_log_tail). Both are landed at the time of writing.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawn, spawnSync } from "node:child_process";
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

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";
import { waitForDaemonRunning } from "./helpers/daemon.js";
import { fetchDashboardJson } from "./helpers/dashboard-fetch.js";

// ---------------------------------------------------------------------------
// Wire-format types — mirror `packages/lich/src/daemon/dashboard/stacks-view.ts`'s
// `StackView`. Duplicated locally (NOT imported) per testing-standards
// §"E2e tests spawn the real binary": the e2e suite stays out-of-process. If
// the wire format ever drifts from this shape, the test fails and the drift
// gets caught — that's the whole point of a separate type definition.
// ---------------------------------------------------------------------------

interface StackViewService {
  name: string;
  kind: "owned" | "compose";
  state: string;
  failure_reason?: string;
  failure_log_tail?: string[];
  ports?: Record<string, number>;
}

interface StackView {
  id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services: StackViewService[];
  primary_url?: string;
  started_at?: string;
}

// ---------------------------------------------------------------------------
// Build the binaries up front. Same pattern as dashboard-stop-action.test.ts
// and daemon-auto-shutdown.test.ts: fail loudly if a build is missing — the
// binaries ARE our code, a broken build is a real bug.
//
// We need BOTH `lich` (the CLI that produces the failed state.json) AND
// `lich-daemon` (the daemon binary the test spawns manually after the
// failed up, because the failure path of `lich up` does NOT auto-start the
// daemon — see the file-level doc comment, item 4).
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
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
// dashboard-stack-list.test.ts / dashboard-stack-detail.test.ts.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

/**
 * Build a fresh fixture: a tmpdir copy of the dogfood-stack with its
 * `lich.yaml` overwritten by the failing variant we ship under
 * `examples/dogfood-stack/lich-failing-variant.yaml`.
 *
 * Why copy from the variant fixture file rather than inline the yaml
 * string in this test:
 *   - The variant has its own doc comment explaining why each field is
 *     shaped the way it is (never-matching ready_when, 5s safety
 *     timeout, etc.). Inlining it here would duplicate that prose.
 *   - Other Plan 5 tasks (or a future "dashboard renders multiple
 *     failure modes" test) can reuse the same fixture by reading it
 *     from the same path.
 *
 * install: false — the failing variant runs `echo + exit 1`, which has
 * no node_modules dependency. Skipping the install keeps the per-test
 * cost under a second on the happy path of setup.
 */
function makeFixture(): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  const variantPath = resolve(
    repoRoot,
    "examples/dogfood-stack/lich-failing-variant.yaml",
  );
  const variantYaml = readFileSync(variantPath, "utf8");
  writeFileSync(join(stack.path, "lich.yaml"), variantYaml, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-dashboard-failed-service-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Belt-and-braces teardown. The failing service has already exited on its
 * own (`exit 1` runs in milliseconds), so there are no owned processes to
 * reap on the stack side. But the daemon we spawned manually in the test
 * body is still alive and will keep its PID/URL files around for ~30s
 * until auto-shutdown fires; subsequent tests in the suite (running
 * single-fork per the vitest config) would see the stale files and
 * misbehave. `lich nuke --yes` is the sledgehammer that kills the daemon
 * SIGTERM-style (per LEV-420 / Plan 5 Task 18) and clears every file.
 *
 * Every step is a separate try/catch so one failure doesn't block the
 * others — a partial teardown is still better than nothing.
 */
function teardownFixture(fix: Fixture): void {
  // LEV-465: timeout tightened from 60s → 20s. afterEach is a fast
  // cleanup path; vitest's hookTimeout already caps at 60s, and
  // `lich nuke --yes` completes sub-200ms even when killing a live
  // daemon. 20s leaves huge headroom while surfacing real hangs loudly.
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
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
// Helpers private to this suite
// ---------------------------------------------------------------------------

/**
 * Find the (single) stack id present under `<lichHome>/stacks/`. Mirrors
 * the same helper in dashboard-stack-list.test.ts / dashboard-stack-detail.test.ts.
 * The test only ever brings one stack up (and the up fails before any
 * second stack could ever exist), so the single-entry assumption holds.
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
 * Spawn the lich-daemon binary as a detached process with the test's
 * isolated LICH_HOME, and `unref()` so the parent test process can exit
 * cleanly without waiting on the daemon. Mirrors the production
 * spawn-shape in `packages/lich/src/daemon/auto-start.ts`'s
 * `ensureDaemonRunning` but applied directly because the failure path of
 * `lich up` doesn't trigger that helper itself (see file-level doc
 * comment, item 4).
 *
 * Returns immediately; callers use `waitForDaemonRunning` from the
 * `helpers/daemon.ts` helper to block until the PID + URL files appear.
 *
 * Why we don't use a non-detached spawn + `kill` in afterEach:
 *   - `lich nuke --yes` in afterEach already kills the daemon via its
 *     PID file (Plan 5 Task 18), and that's the production-correct
 *     teardown path. Adding an explicit `child.kill()` would duplicate
 *     that logic and risk masking a regression in the nuke path.
 *   - Detached + unref'd is the production pattern (`auto-start.ts:217-221`)
 *     so testing this way exercises the same lifecycle the real CLI
 *     uses.
 */
function spawnDaemon(lichHome: string): void {
  const child = spawn(lichDaemonBinary, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LICH_HOME: lichHome,
    },
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard renders failed service with reason", () => {
  it(
    "GET /api/stacks/:id surfaces the broken service with state:failed, failure_reason, and failure_log_tail",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger so a hang anywhere in the test is obvious
      // (matches the pattern from dashboard-stack-list.test.ts /
      // dashboard-stack-detail.test.ts).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser (expected to FAIL) ----------------------
      // `--no-browser` is mostly defensive here — the failure path
      // never reaches the daemon trigger so there's no browser to open
      // either way. Including it matches the production shape `lich up`
      // would receive on a CI runner and protects against a regression
      // where the failure path accidentally starts trying to open a
      // browser.
      //
      // 15s timeout: the cmd exits in milliseconds, the per-level
      // failure path takes another ~1-2s for state.json writes, and the
      // rest is binary startup + shutdown buffer. A 15s ceiling means a
      // regression that hangs `lich up` on the failure path surfaces as
      // a test timeout-failure rather than as a 60s test-runner default.
      step("lich up --no-browser (expects non-zero exit)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });

      // Any per-service failure during `lich up` returns code 1 from
      // runUp (see commands/up.ts:887). A code-0 here would mean the
      // broken service somehow passed ready_when — a load-bearing
      // regression worth catching.
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error(
          "lich up unexpectedly succeeded; stdout was:",
          upResult.stdout,
        );
        // eslint-disable-next-line no-console
        console.error("stderr was:", upResult.stderr);
      }
      expect(upResult.exitCode).not.toBe(0);
      step(`lich up exit ${upResult.exitCode} (as expected)`);

      // ---- wait for state.json: status:failed ---------------------------
      // The per-level failure path in up.ts calls `markStackFailed`, which
      // sets `state.status = "failed"` and writes the snapshot before
      // returning code 1. A short poll budget (3s) accommodates slow-
      // filesystem rename(); the spawnSync exit already happened on the
      // same tick as the write, so this typically resolves on the first
      // poll.
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      step(`stack id: ${stackId}`);

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 3_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      // Sanity-check the snapshot directly: the broken service must be
      // present with state:failed and the failure fields populated. If
      // these aren't on disk, the dashboard projection can't surface
      // them — so we'd rather know about a Plan-4-side regression here
      // than a Plan-5-projection mystery downstream.
      const brokenSnap = snap.services.find((s) => s.name === "broken");
      expect(
        brokenSnap,
        `expected 'broken' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(brokenSnap!.state).toBe("failed");
      step("state.json: broken=failed with failure metadata");

      // ---- spawn the daemon manually ------------------------------------
      // The failure path of `lich up` does NOT trigger `ensureDaemonRunning`
      // (the trigger sits AFTER `state.status = "up"` in commands/up.ts;
      // the per-level failure path returns earlier). To exercise the
      // dashboard's projection of a failed stack we have to spawn the
      // daemon ourselves with the same LICH_HOME so it picks up our
      // failed `state.json` via its filesystem watcher.
      step("spawning lich-daemon manually");
      spawnDaemon(lichHome);

      // ---- wait for daemon (PID + URL files) ----------------------------
      // 15s timeout: the cold-start cost is ~200-500ms for Bun + Bun.serve
      // bind, but the watcher's initial scan on a state root with one
      // entry has to readSnapshot at least once. 15s is generous and
      // matches the dashboard-* tests' shape.
      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 15_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      // ---- GET /api/stacks/:id ------------------------------------------
      // The dashboard server returns a single `StackView` directly for
      // /api/stacks/:id (NOT wrapped in `{ stack: ... }`) — see
      // `server.ts`'s `jsonResponse(stack)` at the segments.length === 1
      // branch of the /api/stacks/* dispatcher. The cache it serves from
      // is populated by `loadStacksView` which surfaces every stack
      // regardless of status (no `up`-only filter), so a `failed` stack
      // is included.
      step(`fetching /api/stacks/${stackId}`);
      const stack = await fetchDashboardJson<StackView>(
        lichHome,
        `/api/stacks/${stackId}`,
      );

      // Stack-level assertions: id matches the directory we discovered;
      // status mirrors the snapshot's "failed".
      expect(stack.id).toBe(stackId);
      expect(stack.status).toBe("failed");

      // The fixture declares exactly one owned service, `broken`. The
      // projection passes the service list through verbatim (no
      // filtering), so we should see exactly that one service in the
      // wire response.
      expect(stack.services).toHaveLength(1);
      const broken = stack.services[0];
      expect(broken.name).toBe("broken");

      // `kind: "owned"` — the projection passes svc.kind through
      // unchanged. A regression that defaulted everything to "compose"
      // (or vice versa) would catch here.
      expect(broken.kind).toBe("owned");

      // The load-bearing assertion: `state: "failed"`. If this is
      // "starting" or "stopped" or "ready", either Plan 4's ProcessExitWatcher
      // didn't fire (didn't flip the state) or the projection mangled
      // the field. Either is a real regression.
      expect(broken.state).toBe("failed");

      // failure_reason: must be defined (Plan 4 wrote it; Plan 5's
      // projection must pass it through). The formatter for
      // ProcessExitWatcher's "exited during startup" path renders the
      // reason as something like "exited with code 1 during startup".
      // Asserting on the literal "code 1" rather than the exact prose
      // means a future copy tweak ("with exit code 1") still passes
      // while a regression that drops the exit code (or substitutes a
      // placeholder) surfaces.
      expect(broken.failure_reason).toBeDefined();
      expect(broken.failure_reason).toContain("code 1");

      // failure_log_tail: an array — possibly empty, possibly contains
      // the "failing" line. The exact contents depend on whether
      // LogTail's 100ms poll observed the file grow before the
      // ProcessExitWatcher fired. Both outcomes are valid per the
      // same caveat documented in `failure-process-exit.test.ts`'s
      // case 1 ("shell can fold the echo into the exit syscall"). The
      // load-bearing check here is that the projection passed an
      // ARRAY through to the wire payload — not `undefined`, not a
      // joined string. An empty array still proves the projection
      // works; a missing field would mean a regression in
      // `projectService`'s pass-through.
      expect(broken.failure_log_tail).toBeDefined();
      expect(Array.isArray(broken.failure_log_tail)).toBe(true);

      step("all /api/stacks/:id failure-projection assertions passed");
    },
    // Per-test timeout: 120s.
    //   - lich up failure path: ~2-5s
    //   - state.json poll: <3s
    //   - daemon spawn + URL file: <15s
    //   - dashboard fetch: <1s
    //   - cushion for slow CI + binary startup
    // The default 120s is plenty; we keep the explicit override for
    // documentation and to match the shape of the other dashboard-* tests.
    120_000,
  );
});
