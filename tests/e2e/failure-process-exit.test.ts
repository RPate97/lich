/**
 * E2e — process exits immediately during startup is detected and surfaced
 * (LEV-371, Plan 4 Task 22).
 *
 * Sentinel for the process-exit failure surface introduced by Plan 4:
 *
 *   - Task 8  — `ProcessExitWatcher` + `formatProcessExitFailure`
 *               (`packages/lich/src/failure/process-exit.ts`)
 *   - Task 9  — `formatFailure({ kind: "exit", exit })` → title + reason
 *   - Task 11 — `Output.failure(block)` (pretty / json / quiet renderers)
 *   - Task 14 — `up.ts` wires `ProcessExitWatcher` around each owned service
 *               and races it against ready_when, translating a non-zero exit
 *               into a `FailureInput` whose formatted block is persisted on
 *               the snapshot as `failure_reason` / `failure_log_tail`
 *   - Task 17 — always-on post-ready exit detection (the legacy 100ms
 *               sentinelMs race promoted into a proper watcher)
 *
 * Two cases exercise distinct points on the lifecycle timeline:
 *
 *   1. **Immediate exit** — `cmd: 'exit 1'`. Service dies before LogTail
 *      observes any output. The failure block should still render cleanly
 *      (title + reason + empty log tail) and state.json should carry the
 *      exit code in `failure_reason`. This is the "did the watcher fire at
 *      all?" sanity check — if Task 8's watcher silently swallows the exit
 *      or up.ts's race never wires the watcher in, this case hangs forever
 *      on the (absent) ready_when.
 *
 *   2. **Brief-run-then-exit** — `cmd: 'echo "loading"; sleep 0.5; exit 2'`.
 *      Service runs ~500ms emitting one line, then exits non-zero before
 *      ready_when (5s timeout) fires. Proves the LogTail buffer captured
 *      the "loading" line BEFORE the exit was observed, and that the
 *      captured content flows through to `failure_log_tail`. The exit code
 *      changes (2, not 1) so a regression that hardcodes `1` somewhere
 *      surfaces immediately.
 *
 * Why a minimal lich.yaml (overwriting dogfood's) rather than injecting into
 * the dogfood yaml:
 *
 *   The dogfood `dev` profile starts postgres + api + web + tunnel_demo in
 *   the same dep level. Per-level `Promise.allSettled` semantics in `up.ts`
 *   wait for every service in the level to settle before failing the step,
 *   so adding an `exiter` service to the dogfood yaml would force the test
 *   to wait for the docker pull just to reach the failure assertion.
 *   Overwriting with a minimal yaml that declares only the exiter keeps the
 *   failure path under 2s while still exercising the same code path
 *   (ProcessExitWatcher → formatFailure → output.failure →
 *   writeStateSnapshot).
 *
 *   The dogfood directory structure (`apps/`, `db/`, etc.) ships
 *   unchanged — the minimal yaml doesn't reference any of it. `install:
 *   false` skips the (slow) bun install since neither cmd needs node_modules
 *   binaries.
 *
 * Output routing — checked against the binary:
 *   - The pretty failure block goes to STDOUT (`createPrettyOutput` writes
 *     to `stream`, which `runUp` wires to `process.stdout`).
 *   - Per-level error summary also goes to STDOUT via `output.error`.
 *   - We assert on combined `stdout + stderr` so a future routing change
 *     (e.g. failures moved to stderr) doesn't silently regress.
 *
 * Cleanup contract:
 *   - `lich down` runs in `afterEach` even when the test body throws. The
 *     exiter services either exit on their own (case 1) or after their
 *     brief run (case 2); `lich down` is the documented re-entry point and
 *     is idempotent.
 *   - Tmpdir + LICH_HOME removed in `afterEach`.
 *
 * Bun-hook timeout dodge:
 *   - Bun's test runner enforces a 5s timeout on beforeAll / afterAll /
 *     beforeEach / afterEach with no per-hook override. Heavier setup /
 *     teardown lives in regular `it()` blocks with explicit timeouts;
 *     this file's afterEach is a light synchronous `lich down` + rmSync
 *     and fits comfortably under 5s.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as failure-fail-when.test.ts /
// failure-ready-timeout.test.ts: the binary IS our code, so a broken build
// should fail loudly rather than be skipped. No-op when dist/lich already
// exists.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
// Per-test fixture state — every test gets a fresh tmpdir / LICH_HOME so
// nothing leaks between tests and the user's real ~/.lich is never touched.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

/**
 * Build a fresh fixture: a tmpdir copy of the dogfood-stack with its
 * `lich.yaml` overwritten by `yaml`. The original `apps/` / `db/`
 * children are untouched — they're unreferenced by the replacement yaml,
 * just inert siblings.
 *
 * `install: false` because neither test case needs node_modules binaries;
 * the exiter cmds are pure `sh -c '...'` lifecycles.
 */
function makeFixture(yaml: string): Fixture {
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-failure-process-exit-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Always-best-effort teardown. `lich down` cleans up any lingering owned
 * service; both test cases' cmds exit on their own, so down is mostly a
 * safety net. A failure here is logged but never thrown — teardown must
 * never mask the test result.
 */
function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
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
 * Find the (single) stack id under `<lichHome>/stacks/`. Mirrors the same
 * helper in failure-fail-when.test.ts / failure-ready-timeout.test.ts —
 * `lich up` writes state.json under a directory whose name is the stack id,
 * but the test doesn't pre-compute the worktree hash; it just picks the
 * only entry present.
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
// Test fixtures: minimal lich.yamls for the two cases
// ---------------------------------------------------------------------------

/**
 * Case 1 — immediate exit. A single owned service whose `cmd` exits 1
 * before printing anything. The orchestrator's ProcessExitWatcher must
 * observe the exit and surface it as a `kind: "exit"` failure.
 *
 * No `ready_when` declared: per `waitReady` in `up.ts`, services with no
 * `ready_when` block resolve immediately on the orchestrator's side, but
 * the ProcessExitWatcher fires before the resolution because the exit
 * lands first (the spawn-to-exit window is ~10ms, dwarfing the
 * orchestrator's setup overhead). Task 17's always-on exit detection
 * ensures the watcher fires even after the synthetic-ready short-circuit.
 *
 * No `port`, no `depends_on`. Single-service stack so the failure happens
 * in level 0 with no `Promise.allSettled` partners slowing the test down.
 *
 * `profiles.dev.default: true` makes the stack pick up `exiter` without
 * needing a positional profile arg on `lich up`.
 */
const IMMEDIATE_EXIT_YAML = `version: "1"

owned:
  exiter:
    # Exit 1 immediately. No stdout, no stderr, no sleep — the supervisor
    # spawns the process, the process dies, the ProcessExitWatcher's
    # exited promise resolves with code 1. The failure block's logTail
    # will be empty (the process emitted nothing); the renderer must
    # handle that case cleanly per the formatter's "no log section" path.
    cmd: 'exit 1'

profiles:
  dev:
    default: true
    owned: [exiter]
`;

/**
 * Case 2 — brief-run-then-exit. The service emits one line, sleeps long
 * enough for the shell to flush stdout to the supervisor's log fd, then
 * exits with a DIFFERENT non-zero code (2, not 1) so a regression that
 * hardcodes `1` anywhere surfaces.
 *
 * Why `sleep 0.5` between the echo and the exit:
 *   `echo` writes to stdout, which under `sh -c '...'` is line-buffered
 *   when connected to a pipe but the supervisor uses a raw file fd
 *   (`stdio: ["ignore", logFd, logFd]`). Without an explicit sleep the
 *   shell's exec-on-last-command optimization can fold the echo into the
 *   exit syscall before LogTail's 100ms poll observes the file's growth,
 *   making `failure_log_tail` empty even though the line was technically
 *   written. The 0.5s pause gives LogTail at least 4 poll ticks to read
 *   the line — comfortably above the noise floor.
 *
 * Why we DO declare a `ready_when` here (unlike case 1):
 *   `up.ts`'s `waitReady` early-returns for services with no `ready_when`
 *   block after a 100ms `checkExitedNow` probe (see up.ts:1490-1510). A
 *   cmd that sleeps 500ms then exits would PASS the 100ms probe (still
 *   alive at t=100ms) and the orchestrator would mark it "ready" before
 *   the exit fires — defeating the purpose of this test. Declaring a
 *   `ready_when.log_match` with a pattern that NEVER matches the service's
 *   actual output forces `waitReady` into its full race assembly: the
 *   ready evaluator (waiting forever for the never-matching pattern) vs
 *   the ProcessExitWatcher (firing when the cmd exits at ~500ms) vs the
 *   ready timeout (5s ceiling). The exit watcher wins — that's the path
 *   the test exercises. The 5s timeout is the orchestrator-side safety
 *   net; if the exit watcher silently regressed, the timeout would still
 *   fail the up within 5s rather than hanging the test for `testTimeout`.
 *
 * Per the implementation note from LEV-371: "use ... sleep 0.2 after
 * the echos" — we use 0.5s to give wider margin on slow CI hosts. The
 * exit code is 2 to differentiate from case 1's code 1.
 */
const BRIEF_RUN_THEN_EXIT_YAML = `version: "1"

owned:
  exiter:
    # Emit "loading", pause for ~500ms (long enough for LogTail's 100ms
    # poll to capture the line at least 4 times over), then exit 2. The
    # ProcessExitWatcher should fire with exitCode=2 around t=500ms, and
    # the LogTail buffer snapshot taken at failure time should include
    # "loading".
    cmd: 'echo "loading"; sleep 0.5; exit 2'
    ready_when:
      # Pattern chosen to NEVER match the service's actual output. Forces
      # waitReady into its full race assembly (ready_evaluator vs
      # exitWatcher vs timeout), so a service that exits at ~500ms gets
      # caught by ProcessExitWatcher even though it survived the 100ms
      # post-spawn probe. See the YAML doc-comment above for why this is
      # required.
      log_match: "READY_NEVER_MATCHES"
      # 5s timeout per the task spec. The exit at ~500ms wins well before
      # this fires; the timeout is the orchestrator-side safety net so a
      # regression that drops the exit watcher would still fail the up
      # within 5s rather than hanging for the 60s test timeout.
      timeout: "5s"

profiles:
  dev:
    default: true
    owned: [exiter]
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up — process exits during startup (Plan 4 Task 22)", () => {
  it(
    "detects an immediate exit (cmd: 'exit 1'), surfaces the failure block with empty log tail, persists exit code to state.json",
    async () => {
      fixture = makeFixture(IMMEDIATE_EXIT_YAML);
      const { stackPath, lichHome } = fixture;

      // ---- lich up ------------------------------------------------------
      // 10s budget: the exit fires within ~10ms of spawn, so the rest of the
      // budget covers binary cold-start + yaml parse + supervisor spawn +
      // shutdown. The acceptance criteria says "~5s"; we double it as
      // headroom for cold CI.
      //
      // `--no-browser` is defensive: this test's `up` exits non-zero before
      // any service reaches ready, so the daemon never spawns and no
      // browser is opened either way. Matches the fast-pool convention.
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });

      // ---- exit code ----------------------------------------------------
      // Any per-service failure during `lich up` returns code 1 from runUp
      // (commands/up.ts:887).
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      // ---- failure-block content on stdout ------------------------------
      // Combined output so a future routing change to stderr doesn't
      // silently break the test.
      const combined = upResult.stdout + "\n" + upResult.stderr;

      // Service name in title — the formatter renders
      // `service "exiter" failed` for exit-kind failures (formatter.ts:231).
      expect(combined).toContain('service "exiter"');

      // The reason from formatProcessExitFailure is
      // `"exited with code 1 during startup"` for an immediate exit
      // (process-exit.ts:218 + describeStage("during_startup")).
      // Asserting on the load-bearing phrase + the exit code (1) — both
      // are guaranteed by the contract between ProcessExitWatcher and the
      // formatter; the "during startup" wording is a load-bearing UX
      // signal but a future tweak ("at startup" / "before ready") would
      // legitimately keep the spirit. Assert on "exited" + "code 1"
      // separately so a copy tweak to either part is caught.
      expect(combined).toContain("exited");
      expect(combined).toContain("code 1");

      // ---- state.json snapshot ------------------------------------------
      const stackId = findStackId(lichHome);
      expect(
        stackId,
        `no stack dir under ${lichHome}/stacks/ — state.json was never written`,
      ).not.toBeNull();

      // Poll briefly: writeStateSnapshot inside markStackFailed is async
      // and the spawnSync exit + our findStackId run in the same tick,
      // but a 2s budget gives the rename() room on slow filesystems.
      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const exiter = snap.services.find((s) => s.name === "exiter");
      expect(
        exiter,
        `expected 'exiter' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(exiter!.state).toBe("failed");

      // Cast for the structural read since `state.ts`'s `ServiceSnapshot`
      // doesn't enumerate the failure fields (added by Task 10 on the lich
      // side — the e2e helper is a minimal shape).
      const exiterWithFailure = exiter as typeof exiter & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };

      // failure_reason: the persisted form of the formatter's `reason`
      // string. For an immediate exit it MUST contain "code 1" (the
      // exit code) — the load-bearing assertion from the acceptance
      // criteria.
      expect(
        exiterWithFailure.failure_reason,
        `exiter.failure_reason was not populated — Task 14's classifier or ` +
          `Task 10's snapshot writer regressed`,
      ).toBeDefined();
      expect(exiterWithFailure.failure_reason).toContain("code 1");

      // failure_log_tail: present even when empty. `exit 1` emits no
      // output, so an empty array is the correct shape. Asserting
      // `toBeDefined` + `Array.isArray` proves the snapshot writer always
      // populates the field for failed services (Task 10's sanitizer
      // guarantee), even when the buffer is empty.
      expect(
        exiterWithFailure.failure_log_tail,
        `exiter.failure_log_tail must be present (possibly empty) for a failed ` +
          `service`,
      ).toBeDefined();
      expect(Array.isArray(exiterWithFailure.failure_log_tail)).toBe(true);
    },
    // Per-test timeout — generous to cover binary build + spawn + the
    // 10s up budget + state.json polling. The happy path completes in
    // ~1-2s on a warm machine.
    60_000,
  );

  it(
    "detects a brief-run-then-exit (cmd emits a line, sleeps, then exits 2), captures the line in failure_log_tail",
    async () => {
      fixture = makeFixture(BRIEF_RUN_THEN_EXIT_YAML);
      const { stackPath, lichHome } = fixture;

      // ---- lich up ------------------------------------------------------
      // 10s budget: the cmd sleeps 0.5s then exits, so total wall-clock is
      // ~1s plus orchestrator overhead. 10s is comfortable headroom.
      //
      // `--no-browser` is defensive: `up` exits non-zero before any
      // service reaches ready, so the daemon never spawns either way.
      // Matches the fast-pool convention.
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 10_000,
      });

      // ---- exit code ----------------------------------------------------
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      // ---- failure-block content ----------------------------------------
      const combined = upResult.stdout + "\n" + upResult.stderr;

      // Service name in title.
      expect(combined).toContain('service "exiter"');

      // Exit code 2 (NOT 1) — proves the formatter picks up the actual
      // exit code from the watcher rather than hardcoding a default. A
      // regression that loses the exit code (e.g. hardcoding `1` somewhere)
      // would surface here.
      expect(combined).toContain("exited");
      expect(combined).toContain("code 2");

      // ---- state.json snapshot ------------------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const exiter = snap.services.find((s) => s.name === "exiter");
      expect(
        exiter,
        `expected 'exiter' service in state.json: ${JSON.stringify(snap.services)}`,
      ).toBeDefined();
      expect(exiter!.state).toBe("failed");

      const exiterWithFailure = exiter as typeof exiter & {
        failure_reason?: string;
        failure_log_tail?: string[];
      };

      // failure_reason: must contain the exit code (2).
      expect(exiterWithFailure.failure_reason).toBeDefined();
      expect(exiterWithFailure.failure_reason).toContain("code 2");

      // failure_log_tail: MUST include the "loading" line. This is the
      // load-bearing assertion for the brief-run-then-exit case — proves
      // LogTail's poll loop captured the pre-exit emission and
      // ProcessExitWatcher's failure handler snapshotted the buffer
      // BEFORE the supervisor tore the file fd down. If the orchestrator's
      // failure path raced the supervisor and the buffer was empty by the
      // time formatFailure ran, this assertion would fail.
      expect(exiterWithFailure.failure_log_tail).toBeDefined();
      expect(Array.isArray(exiterWithFailure.failure_log_tail)).toBe(true);
      expect(exiterWithFailure.failure_log_tail!.length).toBeGreaterThan(0);
      expect(
        exiterWithFailure.failure_log_tail!.some((line) =>
          line.includes("loading"),
        ),
        `expected failure_log_tail to include "loading" line, got: ${JSON.stringify(exiterWithFailure.failure_log_tail)}`,
      ).toBe(true);
    },
    60_000,
  );
});
