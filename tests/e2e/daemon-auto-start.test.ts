/**
 * `lich up` daemon auto-start sentinel — Plan 5 Task 21 (LEV-423).
 *
 * The first `lich up` on a host with no daemon running has to spawn the
 * daemon as a side effect: it writes `<LICH_HOME>/daemon.pid` and
 * `<LICH_HOME>/daemon.url`, then the dashboard HTTP server on the URL
 * answers `/healthz` with 200. The CLI's `--no-browser` flag suppresses
 * the daemon's browser-open side effect (CI tests never want Chrome
 * popping up); the daemon itself still starts, the files still appear,
 * and the dashboard still answers.
 *
 * This is the "does the daemon actually appear?" sentinel. It pairs with
 * daemon-auto-shutdown.test.ts (Task 22) and the various dashboard
 * endpoint tests later in Plan 5 — each one assumes the auto-start path
 * works, so the cheapest place to detect a regression is right here.
 *
 * Test layout (mirrors logs.test.ts's "setup / assertions / teardown"
 * pattern): each phase is its own `it` with an explicit timeout that
 * matches the worst-case latency of that phase. Bun's afterAll hooks
 * cap at 5s with no per-hook override, so the expensive teardown lives
 * in a final `it` rather than `afterAll`. Tests run in declaration
 * order; module-scoped state hands the LICH_HOME / stackPath forward.
 *
 *   1. (setup) `lich up --no-browser` against a tmpdir copy of the
 *      dogfood-stack, with LICH_HOME pointed at a fresh mkdtempSync.
 *      `--no-browser` opts out of `open <url>`, not out of the daemon —
 *      the daemon must still start. Timeout: 300s (supabase first-pull
 *      cold + boot of the full stack).
 *   2. (assert) `waitForDaemonRunning(<LICH_HOME>)` resolves with both
 *      daemon.pid and daemon.url written AND the recorded PID alive
 *      (signal-0 probe). Then `fetch(<url>/healthz)` returns 200 —
 *      proving the dashboard server bound the port the URL file
 *      advertises (a stale URL file would give us a connection error,
 *      not a 200). Timeout: 30s.
 *   3. (teardown) `lich down` then wait for the daemon to auto-shutdown
 *      (or fall through to `lich nuke --yes` as a force-kill). The
 *      auto-shutdown loop exits the daemon ~30s after the last stack
 *      goes away; nuke short-circuits that if shutdown stalls. Timeout:
 *      180s.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (`copyExampleToTmpdir(..., { install: true })`).
 *   - LICH_HOME pointed at a per-suite mkdtempSync so the user's real
 *     ~/.lich is never touched. The daemon's PID/URL files land in THIS
 *     tmpdir, not the user's home — the daemon honors LICH_HOME the
 *     same way every other lich subsystem does (see pid-file.ts §"All
 *     functions honor LICH_HOME environment variable for test isolation").
 *
 * Heavy test; requires docker + supabase CLI v2+ on the host. Without
 * them the first `lich up` fails loudly with the actual underlying error
 * — same contract as basic-up.test.ts (LEV-314).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import {
  readDaemonUrl,
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "./helpers/daemon.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Mirrors basic-up.test.ts / restart-basic.test.ts
// — fail loudly if the build is missing; the binary IS our code, so a broken
// build is a real bug rather than something to skip past.
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
// Module-scoped fixture state — tests run in declaration order, so the
// setup `it` populates these and the assertion + teardown `its` consume
// them. This mirrors logs.test.ts's pattern (chosen because Bun caps
// before/afterAll timeouts at 5s with no override).
// ---------------------------------------------------------------------------

let stackPath: string | null = null;
let stackCleanup: (() => void) | null = null;
let lichHome: string | null = null;

// ---------------------------------------------------------------------------
// afterAll catch-all — if something exploded so badly that the (teardown)
// `it` never ran, this is the last line of defense to keep the user's
// disk + docker state from leaking. Best-effort; the teardown `it` is the
// primary cleanup.
// ---------------------------------------------------------------------------

afterAll(() => {
  if (stackPath && lichHome) {
    try {
      spawnSync(lichBinary, ["nuke", "--yes"], {
        cwd: stackPath,
        env: { ...process.env, LICH_HOME: lichHome },
        timeout: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }
  if (stackCleanup) {
    try {
      stackCleanup();
    } catch {
      /* best-effort */
    }
  }
  if (lichHome && existsSync(lichHome)) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  stackPath = null;
  stackCleanup = null;
  lichHome = null;
});

// ---------------------------------------------------------------------------
// Live progress logger — this is one of the slower e2e tests in the suite
// (full dogfood-stack up = supabase pull + boot). Without progress lines
// the user stares at silence for minutes wondering whether anything's wrong.
// ---------------------------------------------------------------------------

const t0 = Date.now();
function step(label: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`  [+${elapsed}s] ${label}\n`);
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("daemon auto-start on first `lich up`", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-suite LICH_HOME with --no-browser",
    () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Without it the web owned service exits 127
      // immediately and the up never reaches the daemon-trigger step
      // (which sits in the success path AFTER the state-write — see
      // commands/up.ts Plan 5 Task 9 block). Same justification as
      // basic-up.test.ts (LEV-313).
      const copied = copyExampleToTmpdir("dogfood-stack", { install: true });
      stackPath = copied.path;
      stackCleanup = copied.cleanup;
      lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-daemon-auto-start-home-"),
      );

      // `--no-browser` opts out of the daemon's `open <url>` side effect
      // (no Chrome pop-up in CI / on the dev laptop while tests run).
      // The daemon itself MUST still start — `--no-browser` only
      // suppresses the auto-open, not the spawn. See `commands/up.ts`
      // Plan 5 Task 9 block: `ensureDaemonRunning({ openBrowser: !noBrowser })`.
      step("lich up --no-browser (supabase first-pull ~30-90s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 300_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface stdout+stderr so a failed up gives a real diagnostic;
        // otherwise the next assertion fails with "timeout waiting for
        // daemon" and the actual cause (docker not running, supabase CLI
        // missing, etc.) stays hidden.
        throw new Error(
          `lich up failed (exit ${upResult.exitCode})\n` +
            `--- stdout ---\n${upResult.stdout}\n` +
            `--- stderr ---\n${upResult.stderr}`,
        );
      }
      step("lich up exit 0");
    },
    /* timeout */ 300_000,
  );

  it(
    "writes daemon.pid + daemon.url and dashboard /healthz returns 200",
    async () => {
      // Defensive: if the setup `it` threw, these will be null and the
      // assertion fails with a clear message rather than a NPE.
      expect(lichHome, "lichHome — setup it must have run").not.toBeNull();
      expect(stackPath, "stackPath — setup it must have run").not.toBeNull();

      // `waitForDaemonRunning` polls for both files AND probes the PID
      // with signal-0. 30s is plenty: the daemon writes both files
      // within ~500ms of `Bun.serve` binding, and `lich up` has already
      // returned at this point (the trigger sits in the success path
      // BEFORE the summary print). The poll exists primarily to handle
      // the case where the URL file lands a beat after the PID file —
      // both writes happen in `runDaemon`'s start sequence, but they're
      // two separate atomic writes.
      step("waiting for daemon pid + url files");
      const { pid, url } = await waitForDaemonRunning(lichHome!, {
        timeoutMs: 30_000,
      });
      expect(pid).toBeGreaterThan(0);
      // The daemon binds 127.0.0.1 only (local-only tool — no remote
      // surface). The URL must reflect that.
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      step(`daemon alive: pid=${pid} url=${url}`);

      // Sanity: the file-read helper agrees with the polled helper.
      // (waitForDaemonRunning's "url" comes from the same source as
      // readDaemonUrl, but this guards against future divergence.)
      expect(readDaemonUrl(lichHome!)).toBe(url);

      // The dashboard server exposes `/healthz` as its readiness probe
      // (see daemon/dashboard/server.ts). A 200 here proves the daemon
      // didn't just write the URL file and then crash — the server is
      // actively serving on the advertised port.
      step(`probing dashboard /healthz (${url}/healthz)`);
      const healthRes = await fetch(`${url}/healthz`);
      expect(healthRes.status).toBe(200);
      step("dashboard /healthz 200 OK");
    },
    /* timeout */ 30_000,
  );

  it(
    "(teardown) lich down + daemon auto-stops (or nuke as fallback)",
    async () => {
      // No state to tear down? Setup must have bailed; nothing to do
      // here (the afterAll catch-all already covers stragglers).
      if (!stackPath || !lichHome) return;

      // Happy-path teardown: `lich down` removes the only running stack;
      // the daemon's auto-shutdown loop (10s tick × 3 empty checks)
      // notices and exits ~30s later.
      step("lich down");
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

      // `waitForDaemonStopped` resolves either when the PID file is gone
      // (clean shutdown cleared it) or when the recorded PID is dead
      // (crash without cleanup) — both are acceptable from this test's
      // perspective. 60s timeout: the auto-shutdown is ~30s by design
      // (3 × 10s ticks with no live stacks), plus a grace window for
      // the daemon's own shutdown sequence (stop watcher, close
      // `Bun.serve` instances, clear PID/URL files).
      step("waiting for daemon auto-shutdown (~30s by design)");
      let autoStopped = false;
      try {
        await waitForDaemonStopped(lichHome, { timeoutMs: 60_000 });
        autoStopped = true;
        step("daemon stopped cleanly via auto-shutdown");
      } catch (err) {
        // Auto-shutdown stalled. Fall through to `lich nuke --yes` as a
        // force-kill, but surface a warning so a real regression doesn't
        // get silently masked.
        // eslint-disable-next-line no-console
        console.warn(
          "daemon failed to auto-stop within 60s; falling back to nuke:",
          err,
        );
      }

      if (!autoStopped) {
        step("nuke fallback (auto-shutdown stalled)");
        const nukeResult = runLich(["nuke", "--yes"], {
          cwd: stackPath,
          env: { LICH_HOME: lichHome },
          timeout: 90_000,
        });
        // Don't `expect` the exit code — nuke is the cleanup-of-last-
        // resort; if even THAT fails, the afterAll will rmSync the
        // LICH_HOME and the next test starts fresh anyway. We surface
        // the output for diagnostics but don't fail the test on it
        // (the auto-shutdown warning above is the real signal).
        if (nukeResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn("nuke fallback stdout:", nukeResult.stdout);
          // eslint-disable-next-line no-console
          console.warn("nuke fallback stderr:", nukeResult.stderr);
        }
        // After nuke the daemon should be gone for sure.
        await waitForDaemonStopped(lichHome, { timeoutMs: 30_000 });
        step("daemon stopped via nuke fallback");
      }

      // Tmpdir cleanup happens in afterAll (single source of truth) —
      // this `it` only handles the lich + daemon teardown. Keeping
      // tmpdir cleanup in afterAll means a thrown assertion above
      // doesn't skip the rmSync and leak gigabytes of node_modules.
    },
    /* timeout */ 180_000,
  );
});
