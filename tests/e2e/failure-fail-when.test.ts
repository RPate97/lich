/**
 * E2e — `fail_when.log_match` triggers and surfaces correctly
 * (LEV-369, Plan 4 Task 20).
 *
 * Drives the real compiled `lich` binary against a tmpdir copy of the
 * dogfood-stack whose `lich.yaml` has been overwritten with a deliberately-
 * broken config: a single owned service that emits a line matching its
 * `fail_when.log_match` pattern. The pattern (`EADDRINUSE`) is one of the
 * two well-known patterns the formatter (`src/failure/formatter.ts`)
 * synthesises a hint for, so this test exercises both wiring and UX:
 *
 *   1. `lich up` aborts within seconds of the offending log line.
 *   2. Exit code is non-zero.
 *   3. The per-service failure block names the service, quotes the matched
 *      line, and includes the port-conflict hint.
 *   4. `state.json` records the service as `failed`, with `failure_reason`
 *      naming the EADDRINUSE pattern and `failure_log_tail` non-empty.
 *   5. `lich logs <service>` returns the full log (`starting` line followed
 *      by the matched line), proving the supervisor wrote everything to
 *      disk before the orchestrator tore the service down.
 *
 * Why overwrite the lich.yaml rather than append to it:
 *   The dogfood-stack's default `dev` profile includes `postgres`, `api`,
 *   `web`, and `tunnel_demo`. Per-level `Promise.allSettled` semantics in
 *   `up.ts` wait for every service in a level to settle before failing the
 *   step, so adding a bad service to the existing yaml would force the
 *   test to wait for the docker pull just to reach the failure assertion.
 *   Overwriting with a minimal yaml that declares only the bad service
 *   keeps the failure path under 5s while still exercising the same code
 *   path the dogfood demo uses (LogTail → watchFailWhen → formatFailure
 *   → output.failure → writeStateSnapshot).
 *
 *   We still copy the dogfood-stack to tmpdir (rather than `mkdtempSync` +
 *   write a bare `lich.yaml`) so the test exercises the realistic case
 *   where lich starts in a worktree-shaped directory; the unused
 *   `apps/` / `db/` siblings are harmless because nothing in the
 *   replacement yaml references them.
 *
 * Output routing — checked against the binary:
 *   - Pretty failure block goes to STDOUT (`createPrettyOutput` writes to
 *     the `stream`, which `runUp` wires to `process.stdout`).
 *   - Per-level error summary ("failed to start services in step …") also
 *     goes to STDOUT via `output.error`. We assert on `stdout` first and
 *     fall back to combined `stdout + stderr` so a future routing change
 *     (e.g. errors moved to stderr) doesn't silently regress.
 *
 * Cleanup contract:
 *   - `lich down` runs in `afterEach` even when the test body throws. The
 *     bad service is `sleep 99999`, which the supervisor kills via the
 *     owned-service process-group SIGTERM cycle. No docker is started in
 *     the minimal yaml, so down completes quickly.
 *   - Tmpdir + LICH_HOME removed in afterEach.
 *
 * Bun-hook timeout dodge:
 *   - Bun's test runner enforces a 5s timeout on beforeAll / afterAll /
 *     beforeEach / afterEach with no per-hook override. Heavier setup /
 *     teardown lives in regular `it()` blocks with explicit timeouts where
 *     needed. This file's afterEach is light (a synchronous `lich down`
 *     + rmSync) and fits comfortably under 5s.
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
// Build the binary up front. Same pattern as basic-up.test.ts and
// failure-validate-bad-regex.test.ts: the binary IS our code, so a broken
// build should fail loudly rather than be skipped. No-op when dist/lich
// already exists.
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
 */
function makeFixture(yaml: string): Fixture {
  // install: false — the replacement yaml runs a `sh -c 'echo …; sleep …'`
  // command that doesn't depend on any locally-installed binary, so we
  // skip the (slow) bun install in the tmpdir.
  const stack = copyExampleToTmpdir("dogfood-stack", { install: false });
  writeFileSync(join(stack.path, "lich.yaml"), yaml, "utf8");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-failure-fail-when-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Always-best-effort teardown. `lich down` shuts down any lingering owned
 * services (the `sleep 99999` in our replacement yaml is what we mostly
 * care about cleaning up); then the tmpdir + LICH_HOME are removed.
 *
 * Note: when `lich up` returns exit 1 for a per-level failure, the
 * orchestrator does NOT proactively tear down services that started
 * successfully in earlier levels (see up.ts:872-887). The minimal yaml
 * here puts the bad service in the only level, so on failure there's
 * nothing else to clean up — but `lich down` is idempotent and harmless,
 * so we always call it.
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
 * helper in basic-up.test.ts — `lich up` writes state.json under a directory
 * whose name is the stack id, but the test doesn't pre-compute the worktree
 * hash; it just picks the only entry present.
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
 * Minimal lich.yaml with a single owned service whose stdout matches its
 * `fail_when.log_match` pattern. Shape:
 *
 *   - `cmd` echoes a benign first line (`starting`) followed by the
 *     EADDRINUSE-bearing line. The `starting` line proves the supervisor
 *     captured pre-match output too — the `failure_log_tail` field should
 *     include it.
 *   - `sleep 99999` keeps the process alive so the failure path is
 *     "LogTail catches a fail_when match while the service is still
 *     running," not "service exited and we caught the EADDRINUSE line
 *     post-mortem." This is the spec'd intent of `fail_when.log_match`
 *     (Plan 4 design §"fail_when").
 *   - `ready_when.log_match: "READY_NEVER_MATCHES"` (with a long enough
 *     `timeout` to outlive the test) is REQUIRED, not optional. The
 *     orchestrator's `waitReady` short-circuits with `if (!ready) return`
 *     when no `ready_when` is declared (up.ts:1543), so without a
 *     ready_when block the fail_when watcher is never wired into the race
 *     and the service moves straight to `ready` regardless of what it
 *     logs. With a never-matching ready evaluator, `waitReady` builds the
 *     `Promise.race` over [evaluator, watchFailWhen, exitWatcher] and
 *     `watchFailWhen` wins on the first matching line — the exact path
 *     the dogfood-stack's tunnel_demo + api services exercise in
 *     production. The 30s timeout is generous: fail_when should fire
 *     within ~100ms (LogTail's poll interval) of the echoed line, so the
 *     timeout never gets a chance to elapse in a healthy test run; it
 *     exists only so a hypothetical regression that drops the
 *     fail_when watcher would produce a timeout-failure rather than
 *     hanging the test for `testTimeout` (60s) seconds.
 *   - No `port`, no `depends_on`. Single-service stack so the failure
 *     happens in level 0 with no `Promise.allSettled` partners slowing
 *     the test down.
 *
 * `version: "1"` is the schema version the parser expects.
 * `profiles.dev.default: true` makes the stack pick up `bad` without
 *   needing a positional profile arg on `lich up`.
 */
const FAIL_WHEN_YAML = `version: "1"

owned:
  bad:
    # Emit a benign line first (so failure_log_tail proves it captured
    # pre-match content too), then the line that trips fail_when, then
    # sleep so the service is still RUNNING when the orchestrator races
    # fail_when against the (absent) ready_when promise. This is the
    # canonical fail_when shape: catch a problem in a live service's
    # stdout, not after the service has already exited.
    cmd: 'echo "starting"; echo "EADDRINUSE somewhere"; sleep 99999'
    ready_when:
      # Pattern chosen to NEVER match the service's actual output. The
      # role of ready_when here is structural — it forces waitReady to
      # enter its race assembly so the fail_when watcher gets wired in.
      # See the FAIL_WHEN_YAML doc-comment above for the full rationale.
      log_match: "READY_NEVER_MATCHES"
      # Long timeout so the test never sees a timeout-failure when
      # everything's working. fail_when fires within ~100ms (LogTail poll
      # interval); 30s is pure headroom for a hypothetical regression.
      timeout: "30s"
    fail_when:
      # EADDRINUSE is one of the two patterns formatFailure's inferHint
      # recognizes (the other is "Cannot find module") — picking it here
      # lets the test assert on both the matched line AND the synthesized
      # hint without depending on a second config knob.
      log_match: "EADDRINUSE"

profiles:
  dev:
    default: true
    owned: [bad]
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up — fail_when.log_match (Plan 4 Task 20)", () => {
  it(
    "aborts within seconds, surfaces the failure block + hint, persists failure to state.json",
    async () => {
      fixture = makeFixture(FAIL_WHEN_YAML);
      const { stackPath, lichHome } = fixture;

      // ---- lich up ------------------------------------------------------
      // `runLich` (spawnSync) is the right shape here: lich up returns once
      // the stack is either fully ready or has failed, and on failure we
      // want the captured stdout/stderr to assert against. The 15s budget
      // is generous — LogTail polls at 100ms so fail_when typically fires
      // within ~200ms of the echoed line; the rest of the budget covers
      // binary startup, yaml parse, supervisor spawn, and shutdown.
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 15_000,
      });

      // ---- exit code ----------------------------------------------------
      // Any per-service failure during `lich up` returns code 1 from runUp
      // (see commands/up.ts:887).
      if (upResult.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("lich up unexpectedly succeeded; stdout was:");
        // eslint-disable-next-line no-console
        console.error(upResult.stdout);
      }
      expect(upResult.exitCode).not.toBe(0);

      // ---- failure-block content on stdout ------------------------------
      // The pretty failure block is written to the main output stream,
      // which runUp wires to process.stdout. Assert on stdout first; fall
      // back to combined output so a future routing change to stderr
      // doesn't silently break the test.
      const combined = upResult.stdout + "\n" + upResult.stderr;

      // Title: `✗ service "bad" matched fail_when pattern`
      // The "✗" icon may or may not be present depending on ANSI handling
      // on the captured pipe (non-TTY → no color but the icon is plain
      // text, so it IS present in our pipe). Assert on the load-bearing
      // service-name + verb instead.
      expect(combined).toContain('service "bad"');
      expect(combined).toContain("matched fail_when pattern");

      // Reason: the matched log line is quoted in the reason text.
      // (see failure/formatter.ts:265 — `fail_when matched log line: "…"`)
      expect(combined).toContain("EADDRINUSE somewhere");

      // Hint: the formatter's inferHint maps EADDRINUSE → the
      // port-conflict guidance string. Asserting on the literal hint
      // sentence ensures the wiring (formatter → renderer) is intact.
      // (see failure/formatter.ts:390-392)
      expect(combined).toContain(
        "run `lich stacks` to find what's using the port",
      );

      // ---- state.json snapshot ------------------------------------------
      // The orchestrator calls `markStackFailed` (which writes
      // state.status:"failed") on the per-level failure path. Per-service
      // `failure_reason` + `failure_log_tail` were set inside
      // startOneService's catch block (up.ts:1124-1125) before re-throw,
      // so the snapshot persisted to disk should carry them.
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      // Poll briefly: writeStateSnapshot inside markStackFailed is async
      // and the spawnSync exit + our findStackId run in the same tick,
      // but a 2s budget gives the rename() room on slow filesystems.
      const snap = await waitForStackStatus(lichHome, stackId!, "failed", {
        timeoutMs: 2_000,
        intervalMs: 100,
      });
      expect(snap.status).toBe("failed");

      const bad = snap.services.find((s) => s.name === "bad");
      expect(bad, `expected 'bad' service in state.json: ${JSON.stringify(snap.services)}`)
        .toBeDefined();
      expect(bad!.state).toBe("failed");

      // failure_reason: the formatter renders this as
      // `fail_when matched log line: "EADDRINUSE somewhere"` — assert the
      // load-bearing tokens (the pattern name + the matched line) so a
      // future copy tweak doesn't break the test, but a regression that
      // drops the actual match info does.
      expect(bad!.failure_reason).toBeDefined();
      expect(bad!.failure_reason).toContain("EADDRINUSE");

      // failure_log_tail: non-empty array. The exact lines depend on
      // shell flushing timing — the `starting` line MAY or MAY NOT have
      // flushed before the EADDRINUSE line (echo to a pipe is line-
      // buffered so they usually both land), but at minimum the matched
      // line itself must be there. Assert non-empty + contains the
      // match — both are guaranteed by the contract that LogTail emitted
      // the line that triggered fail_when, and the buffer snapshot taken
      // at failure time includes everything LogTail has seen.
      expect(bad!.failure_log_tail).toBeDefined();
      expect(bad!.failure_log_tail!.length).toBeGreaterThan(0);
      expect(
        bad!.failure_log_tail!.some((line) => line.includes("EADDRINUSE")),
        `expected failure_log_tail to include the matched line, got: ${JSON.stringify(bad!.failure_log_tail)}`,
      ).toBe(true);

      // ---- lich logs <service> returns the FULL log ---------------------
      // The supervisor writes the service's stdout/stderr to a per-stack
      // log file via O_APPEND on a raw fd (see owned/supervisor.ts). After
      // up fails, that file is still on disk; `lich logs bad --no-follow`
      // reads it and prints the content. The full log should include
      // BOTH the `starting` line and the `EADDRINUSE somewhere` line,
      // even though the failure block's tail might (in principle) have
      // trimmed older lines. Here both lines fit comfortably in the 20-
      // line LOG_TAIL_LINES cap, so both will appear in both places —
      // but the load-bearing assertion is that `lich logs` returns the
      // full file, not a trimmed view.
      const logsResult = runLich(["logs", "bad", "--no-follow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 5_000,
      });
      expect(logsResult.exitCode).toBe(0);
      expect(logsResult.stdout).toContain("starting");
      expect(logsResult.stdout).toContain("EADDRINUSE somewhere");
    },
    // Per-test timeout — generous to cover binary build + spawn + the
    // 15s up budget + a slow filesystem rename for state.json. The
    // happy path completes in ~2-3s on a warm machine.
    60_000,
  );
});
