/**
 * Daemon main entry — wires watcher, dashboard stub, proxy stub,
 * auto-shutdown, and PID file lifecycle (LEV-406, Plan 5 Task 4).
 *
 * The lich daemon is a single per-machine background process started
 * implicitly by `lich up` on the first stack of the session. Its
 * responsibilities (per spec section 6) are:
 *
 *   1. Host the dashboard HTTP server (real implementation in Task 6)
 *   2. Host the reverse-proxy server (real implementation in Task 11)
 *   3. Watch the state directory for stack changes and re-fan that
 *      signal to both servers
 *   4. Auto-shut down ~30s after the last stack stops, so the user
 *      doesn't accumulate idle daemons on their machine
 *
 * This task wires the FRAMEWORK for all four. The dashboard and proxy
 * are currently logged-only stubs — Tasks 6 and 11 swap in the real
 * `Bun.serve` instances. The watcher and auto-shutdown loop are real,
 * since they're the lifecycle skeleton that the later tasks plug into.
 *
 * ## Lifecycle in one paragraph
 *
 * On start: write the PID file (so subsequent `lich up`s see "daemon is
 * alive" and short-circuit), start the watcher pointed at
 * `<LICH_HOME>/stacks`, log the dashboard + proxy stub placeholders,
 * then enter the auto-shutdown polling loop. The loop ticks every
 * `shutdownCheckMs` (default 10s); each tick counts how many "alive"
 * stacks exist (status in `up | starting | partial | stopping`). When
 * the count is zero for `shutdownGraceTicks` consecutive ticks (default
 * 3 → ~30s), we exit cleanly. On SIGTERM/SIGINT or via `opts.signal`
 * abort, we run cleanup synchronously: stop watcher, clear PID file,
 * resolve with exit code 0.
 *
 * ## Why the K-of-N shutdown rule
 *
 * A single empty check would cause "lich down then immediately lich up"
 * to race the daemon shutting itself down between the two commands.
 * K=3 at 10s intervals gives a ~30s grace window where the daemon waits
 * to see if anything else starts up. This matches the spec's design.
 *
 * ## Why a stub for dashboard and proxy
 *
 * The skeleton (PID file, watcher, signal handlers, auto-shutdown) is
 * what every subsequent task plugs into. Building it first lets us
 * unit-test the lifecycle behaviors in isolation — start/stop, signal
 * handling, auto-shutdown timing — without dragging in the dashboard's
 * HTTP server or the proxy's port binding. Tasks 6 (dashboard) and 11
 * (proxy) replace the stub log lines with real server lifecycles, and
 * Task 12 wires the watcher's `onChange` callback to both servers'
 * refresh hooks.
 *
 * ## Concurrent abort safety
 *
 * Cleanup is gated by an `isCleanedUp` flag plus a single in-flight
 * `cleanupPromise`. The first abort path (signal abort, SIGTERM, SIGINT,
 * or completion of the auto-shutdown countdown) runs cleanup; all
 * subsequent calls await that same promise rather than double-stopping
 * the watcher or double-removing the PID file. This matters because the
 * runtime can deliver SIGTERM and SIGINT in quick succession (e.g. when
 * a user hits Ctrl-C while the OS is also shutting the process down),
 * and double-cleanup would race the file removal in undefined ways.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clearDaemonPid,
  isDaemonAlive,
  writeDaemonPid,
  type PidFileOpts,
} from "./pid-file.js";
import { StateWatcher } from "./watcher.js";
import { readSnapshot, type StackStatus } from "../state/snapshot.js";

/**
 * Options accepted by {@link runDaemon}.
 *
 * `lichHome` and `proxyPort` mirror the env vars the shim binary
 * (`bin/lich-daemon.ts`) parses from `LICH_HOME` and `LICH_PROXY_PORT`.
 * `signal` is the abort handle the caller (in production: nothing; in
 * tests: the test harness) uses to request a graceful stop. The
 * `shutdownCheckMs` and `shutdownGraceTicks` knobs exist for test
 * isolation — the production defaults give ~30s grace, but a unit test
 * doesn't want to wait that long.
 */
export interface RunDaemonOpts {
  /**
   * Override the LICH_HOME root for this daemon. When set, the PID
   * file and stacks directory live under `<lichHome>/`. When unset,
   * falls back to the `LICH_HOME` env var or `~/.lich`. Primarily used
   * by tests to isolate filesystem effects to a tmpdir.
   *
   * Note: also propagates into `process.env.LICH_HOME` for the duration
   * of `runDaemon` so the unmodified `stateRoot()` / `listStacks()` /
   * `readSnapshot()` helpers (which key off the env var) inherit the
   * same root. The previous value is restored on clean shutdown.
   */
  lichHome?: string;

  /**
   * Port the reverse proxy WILL bind on (Task 11). For now we just log
   * the intent — the actual `Bun.serve` lands in Task 11. Default 3300
   * per the spec.
   */
  proxyPort?: number;

  /**
   * Abort signal for graceful shutdown. When fired, the daemon stops
   * the watcher, clears the PID file, and resolves the `runDaemon`
   * promise. Tests use this to drive the shutdown path without having
   * to send a real OS signal.
   */
  signal?: AbortSignal;

  /**
   * Stream to write daemon log lines to. Defaults to `process.stdout`.
   * Tests pass a buffer-backed stream to capture log output.
   */
  out?: NodeJS.WritableStream;

  /**
   * Auto-shutdown poll interval in milliseconds. Default 10_000.
   * Tests pass a much smaller value (e.g. 20ms) so the auto-shutdown
   * path finishes in test-friendly time.
   */
  shutdownCheckMs?: number;

  /**
   * Number of consecutive empty checks required before auto-shutdown.
   * Default 3 (≈30s at the default 10s interval). Tests pass 1 or 2
   * to shorten the test runtime.
   */
  shutdownGraceTicks?: number;
}

/**
 * Result of a daemon run. The exit code is 0 on clean shutdown
 * (signal-aborted, SIGTERM/SIGINT, or auto-shutdown countdown) and
 * non-zero when startup failed (e.g. another daemon already owns the
 * PID file).
 */
export interface RunDaemonResult {
  exitCode: number;
}

/** Default auto-shutdown tick interval — matches the spec's ~10s rule. */
const DEFAULT_SHUTDOWN_CHECK_MS = 10_000;

/** Default consecutive empty ticks before auto-shutdown (≈30s grace). */
const DEFAULT_SHUTDOWN_GRACE_TICKS = 3;

/**
 * Stack statuses that count as "alive" for the auto-shutdown check.
 * Stacks with status `stopped` or `failed` are history and don't
 * prevent the daemon from exiting.
 */
const ALIVE_STATUSES: ReadonlySet<StackStatus> = new Set<StackStatus>([
  "starting",
  "up",
  "partial",
  "stopping",
]);

/**
 * Resolve the directory the daemon watches (mirrors `state/directory.ts`'s
 * `stateRoot()` resolution but parameterized by the explicit `lichHome`
 * option so tests don't have to mutate `process.env` directly).
 *
 * Resolution order:
 *   1. Explicit `lichHome` argument
 *   2. `LICH_HOME` environment variable
 *   3. `~/.lich`
 *
 * Always returns `<root>/stacks`.
 */
function resolveStateRoot(lichHome: string | undefined): string {
  if (lichHome && lichHome.length > 0) {
    return join(lichHome, "stacks");
  }
  const env = process.env.LICH_HOME;
  if (env && env.length > 0) {
    return join(env, "stacks");
  }
  return join(homedir(), ".lich", "stacks");
}

/**
 * Count how many stacks under `stateRoot` have an "alive" status in
 * their `state.json`. Used by the auto-shutdown loop to decide whether
 * to tick the empty-counter forward or reset it.
 *
 * Tolerant: missing stateRoot → 0 (fresh install with no `lich up`
 * ever); unparseable state.json → not counted (best-effort).
 */
async function countAliveStacks(stateRoot: string): Promise<number> {
  // Inline implementation rather than calling `listStacks()` so we can
  // (a) read each snapshot in the same scan rather than double-scanning,
  // (b) honor a stateRoot that may differ from the global one if the
  // caller passed an explicit `lichHome` and we haven't mutated the env.
  let entries: string[];
  try {
    entries = await readdir(stateRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  let alive = 0;
  for (const name of entries) {
    let isDir: boolean;
    try {
      const s = await stat(join(stateRoot, name));
      isDir = s.isDirectory();
    } catch {
      // Race with concurrent removal — skip.
      continue;
    }
    if (!isDir) continue;

    // Each subdir name IS the stack id. `readSnapshot` keys off the
    // global `stateRoot()`, so we rely on the env var having been set
    // by `runDaemon` before this call. If the snapshot is missing or
    // malformed, treat the stack as not-alive (it's transitional).
    const snap = await readSnapshot(name).catch(() => null);
    if (snap && ALIVE_STATUSES.has(snap.status)) {
      alive++;
    }
  }
  return alive;
}

/**
 * Write one line to the daemon's log stream with a timestamp prefix.
 * The format matches what `lich up`'s pretty output uses — minimal,
 * not styled, easy to grep. Failures are swallowed (the daemon should
 * not crash on a broken stdout).
 */
function log(out: NodeJS.WritableStream, line: string): void {
  try {
    out.write(`[lich-daemon] ${line}\n`);
  } catch {
    // Best-effort. A broken stdout shouldn't take down the daemon.
  }
}

/**
 * Run the lich daemon main loop.
 *
 * Returns when:
 *   - `opts.signal` is aborted (clean shutdown, exit 0)
 *   - SIGTERM or SIGINT is received (clean shutdown, exit 0)
 *   - The auto-shutdown countdown elapses (exit 0)
 *   - Startup fails because another daemon already owns the PID file
 *     (exit 1)
 *
 * The dashboard and proxy are currently stub log lines — Tasks 6 and
 * 11 land the real servers, and Task 12 rewires the watcher's
 * `onChange` to refresh both. This task ships the lifecycle skeleton
 * that those swap-ins plug into.
 */
export async function runDaemon(
  opts: RunDaemonOpts = {},
): Promise<RunDaemonResult> {
  const out = opts.out ?? process.stdout;
  const proxyPort = opts.proxyPort ?? 3300;
  const shutdownCheckMs = opts.shutdownCheckMs ?? DEFAULT_SHUTDOWN_CHECK_MS;
  const shutdownGraceTicks =
    opts.shutdownGraceTicks ?? DEFAULT_SHUTDOWN_GRACE_TICKS;

  const pidOpts: PidFileOpts | undefined =
    opts.lichHome !== undefined ? { lichHome: opts.lichHome } : undefined;

  // ---- 1. Refuse to start when an alive daemon owns the PID file -----
  // Stale-PID detection is built into `isDaemonAlive`: a PID file
  // pointing at a dead process is treated as no daemon, and we'll
  // overwrite it via the subsequent `writeDaemonPid`. Only a *live*
  // PID makes us bail out.
  if (await isDaemonAlive(pidOpts)) {
    process.stderr.write(
      "lich-daemon: another daemon is already running for this LICH_HOME\n",
    );
    return { exitCode: 1 };
  }

  // ---- 2. Propagate LICH_HOME into env so the existing helpers work --
  // `state/directory.ts`'s `stateRoot()` (used by `readSnapshot` and
  // the watcher's stateRoot below) keys off `process.env.LICH_HOME`.
  // When the caller passed an explicit `lichHome`, mirror it into the
  // env for the daemon's lifetime so both pid-file (via opts) and the
  // shared state helpers (via env) see the same root.
  const prevLichHome = process.env.LICH_HOME;
  if (opts.lichHome !== undefined) {
    process.env.LICH_HOME = opts.lichHome;
  }

  // ---- 3. Write PID file ---------------------------------------------
  await writeDaemonPid(process.pid, pidOpts);

  // ---- 4. Start watcher pointed at <LICH_HOME>/stacks ----------------
  const stateRoot = resolveStateRoot(opts.lichHome);
  const watcher = new StateWatcher({
    stateRoot,
    // Task 12 will rewire this to call both dashboard.refresh() and
    // routingTable.reload(). For Task 4 we just log so the test can
    // assert the wiring exists.
    onChange: () => {
      log(out, `state change detected under ${stateRoot}`);
    },
  });
  await watcher.start();

  // ---- 5. Stub log lines for dashboard + proxy -----------------------
  // Tasks 6 and 11 replace these with real `Bun.serve` instances. The
  // log lines establish the intended startup ordering and give tests
  // something concrete to assert against.
  log(out, "dashboard would start here on port <allocated>");
  log(out, `proxy would start here on port ${proxyPort}`);

  // ---- 6. Cleanup machinery (idempotent, race-safe) ------------------
  // Cleanup is gated by `cleanupPromise` so concurrent abort paths
  // (signal abort + SIGTERM + auto-shutdown completing simultaneously)
  // converge on a single in-flight cleanup. All callers await the same
  // promise rather than double-stopping the watcher.
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      // Order matters: stop the watcher first so no more onChange
      // callbacks fire mid-teardown, then drop the PID file so the
      // next `lich up` sees a clean slate.
      await watcher.stop().catch(() => {});
      await clearDaemonPid(pidOpts).catch(() => {});
      // Restore env to whatever it was before runDaemon mutated it.
      if (opts.lichHome !== undefined) {
        if (prevLichHome === undefined) {
          delete process.env.LICH_HOME;
        } else {
          process.env.LICH_HOME = prevLichHome;
        }
      }
    })();
    return cleanupPromise;
  };

  // ---- 7. Wire shutdown triggers -------------------------------------
  // Three paths all converge on `signalShutdown()`, which resolves the
  // outer promise and lets the main flow run cleanup once. Each path
  // is idempotent — setting `shutdownReason` repeatedly is fine.
  let shutdownReason: string | null = null;
  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const signalShutdown = (reason: string): void => {
    if (shutdownReason !== null) return; // already shutting down
    shutdownReason = reason;
    log(out, `shutdown requested: ${reason}`);
    resolveExit?.();
  };

  // Per-signal handlers we'll install and remove around the main loop.
  // We install on SIGTERM and SIGINT — both common kill-the-daemon
  // gestures (CI, supervisord, user Ctrl-C in attached terminal).
  const onSigTerm = (): void => signalShutdown("SIGTERM");
  const onSigInt = (): void => signalShutdown("SIGINT");
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);

  // The caller's signal (if any) is wired to the same shutdown path.
  // If it's already aborted by the time we get here, signalShutdown
  // runs immediately and the main loop exits on first iteration.
  const onAbort = (): void => signalShutdown("signal-abort");
  if (opts.signal) {
    if (opts.signal.aborted) {
      signalShutdown("signal-already-aborted");
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // ---- 8. Auto-shutdown polling loop ---------------------------------
  // Each tick: count alive stacks. If zero, increment the empty-tick
  // counter; if ≥ shutdownGraceTicks, fire the shutdown. If non-zero,
  // reset the counter.
  let emptyTicks = 0;
  let shutdownTimer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (shutdownReason !== null) return; // shutdown in flight; stop ticking
    const alive = await countAliveStacks(stateRoot).catch(() => 0);
    if (alive === 0) {
      emptyTicks++;
      if (emptyTicks >= shutdownGraceTicks) {
        signalShutdown(`auto-shutdown (${emptyTicks} empty ticks)`);
        return;
      }
    } else {
      // Reset the counter on any sign of life — a stack came back up
      // (or a new one started) inside the grace window.
      emptyTicks = 0;
    }
    // Schedule the next tick. We use setTimeout rather than setInterval
    // so the next check is scheduled relative to "now" not "when the
    // previous one started" — keeps the loop honest if a snapshot read
    // happens to be slow.
    if (shutdownReason === null) {
      shutdownTimer = setTimeout(tick, shutdownCheckMs);
    }
  };

  // Kick off the first tick on a delay so the daemon doesn't auto-shut
  // immediately on startup when no stacks exist yet (`lich up` writes
  // state.json AFTER spawning the daemon). One full interval of grace
  // before the first count.
  shutdownTimer = setTimeout(tick, shutdownCheckMs);

  // ---- 9. Wait for shutdown ------------------------------------------
  await exitPromise;

  // ---- 10. Final cleanup ---------------------------------------------
  // Always run cleanup before returning so the PID file is gone before
  // any caller sees the resolved promise. Wraps the same idempotent
  // function above so re-entry (e.g. SIGTERM during the cleanup) is a
  // no-op.
  if (shutdownTimer !== null) clearTimeout(shutdownTimer);
  process.off("SIGTERM", onSigTerm);
  process.off("SIGINT", onSigInt);
  if (opts.signal && !opts.signal.aborted) {
    opts.signal.removeEventListener("abort", onAbort);
  }
  await runCleanup();

  return { exitCode: 0 };
}
