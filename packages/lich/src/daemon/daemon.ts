/**
 * Daemon main entry — wires the real dashboard server, the real reverse
 * proxy, the state-directory watcher, auto-shutdown, and PID + URL file
 * lifecycle (LEV-406 + LEV-414, Plan 5 Tasks 4 + 12).
 *
 * The lich daemon is a single per-machine background process started
 * implicitly by `lich up` on the first stack of the session. Its
 * responsibilities (per spec section 6) are:
 *
 *   1. Host the dashboard HTTP server on an ephemeral port and record
 *      the bound URL in `<LICH_HOME>/daemon.url`. The auto-start hook
 *      (`auto-start.ts`) polls this file so `lich up` can print the URL
 *      in its summary block.
 *   2. Host the reverse-proxy server on the configured `runtime.proxy_port`
 *      (`runtime.proxy_port` from the active stack's lich.yaml, or a
 *      worktree-derived port in 30000-50000 when unset — see LEV-479).
 *      Browsers reach `http://<service>.<worktree>.lich.localhost:<port>/`;
 *      the proxy routes by Host header to the right per-stack upstream.
 *   3. Watch the state directory for stack changes and re-fan that
 *      signal to BOTH servers — the dashboard invalidates its cached
 *      stacks view; the proxy rebuilds its routing table from the
 *      current set of `state.json` files.
 *   4. Auto-shut down ~30s after the last stack stops, so the user
 *      doesn't accumulate idle daemons on their machine.
 *
 * ## Lifecycle in one paragraph
 *
 * On start: write the PID file (so subsequent `lich up`s see "daemon is
 * alive" and short-circuit), start the watcher pointed at
 * `<LICH_HOME>/stacks`, load the routing table once, start the proxy on
 * the configured port, start the dashboard on an ephemeral port, write
 * the dashboard URL to `<LICH_HOME>/daemon.url`, then enter the
 * auto-shutdown polling loop. The loop ticks every `shutdownCheckMs`
 * (default 10s); each tick counts how many "alive" stacks exist
 * (status in `up | starting | partial | stopping`). When the count is
 * zero for `shutdownGraceTicks` consecutive ticks (default 3 → ~30s),
 * we exit cleanly. On SIGTERM/SIGINT or via `opts.signal` abort, we
 * run cleanup synchronously: stop watcher, stop dashboard, stop proxy,
 * clear PID + URL files, resolve with exit code 0.
 *
 * ## Why the K-of-N shutdown rule
 *
 * A single empty check would cause "lich down then immediately lich up"
 * to race the daemon shutting itself down between the two commands.
 * K=3 at 10s intervals gives a ~30s grace window where the daemon waits
 * to see if anything else starts up. This matches the spec's design.
 *
 * ## Why dashboard URL ≠ proxy URL
 *
 * Two separate `Bun.serve` instances on two separate ports:
 *
 *   - Dashboard: ephemeral port (`port: 0`), URL recorded in
 *     `daemon.url`. This is what the user clicks.
 *   - Proxy: preferred port from lich.yaml (or worktree-derived default,
 *     LEV-479), URL is implicit in every friendly URL
 *     (`http://api.<worktree>.lich.localhost:<port>/`).
 *
 * The URL file records ONLY the dashboard URL because that's the
 * canonical "open this in your browser" target. The proxy's port is
 * inferred by the user from the friendly URLs `lich urls` prints.
 *
 * ## Watcher fan-out: dashboard refresh AND routing reload
 *
 * The watcher fires `onChange` after debouncing a burst of state.json
 * writes (Plan 5 Task 3). The daemon's callback hits two subsystems:
 *
 *   - `dashboardServer.refresh()` — fire-and-forget; the dashboard
 *     kicks off an async reload of its cached `StackView` list. In-flight
 *     dashboard requests see the previous cache; subsequent requests see
 *     the new one. Atomic swap inside the server.
 *   - `routingTable.reload(stateRoot)` — async; the routing table
 *     rebuilds the in-memory hostname → upstream map from scratch. The
 *     proxy reads from this same table on every request via `.get()`.
 *
 * Both calls fire independently — a failure in one doesn't prevent the
 * other from running. The routing reload's promise is awaited (catching
 * errors) inside the callback so the proxy is consistent with the
 * latest disk state by the time the next request comes in.
 *
 * ## Concurrent abort safety
 *
 * Cleanup is gated by a single in-flight `cleanupPromise`. The first
 * abort path (signal abort, SIGTERM, SIGINT, or completion of the
 * auto-shutdown countdown) runs cleanup; all subsequent calls await
 * that same promise rather than double-stopping the servers or
 * double-removing the PID/URL files. This matters because the runtime
 * can deliver SIGTERM and SIGINT in quick succession (e.g. when a user
 * hits Ctrl-C while the OS is also shutting the process down), and
 * double-cleanup would race the file removal in undefined ways.
 *
 * ## Server-startup failures don't crash the daemon
 *
 * `Bun.serve` can fail to bind for two reasons: the configured proxy
 * port is in use by another process, or the OS denied the bind (rare
 * for ephemeral ports). The dashboard's bind failure is treated as a
 * hard error — without a dashboard URL there's nothing to record in
 * `daemon.url` and no UI to surface. The proxy's bind failure logs a
 * warning but the daemon stays up — the user can still use raw
 * `localhost:<port>` URLs via `lich urls --raw`. This matches the
 * "dashboard fails gracefully" spec language while still letting the
 * dashboard remain the primary failure signal.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clearDaemonPid,
  clearDaemonUrl,
  isDaemonAlive,
  writeDaemonPid,
  writeDaemonUrl,
  type PidFileOpts,
} from "./pid-file.js";
import { StateWatcher } from "./watcher.js";
import { startDashboardServer, type DashboardServer } from "./dashboard/server.js";
import { deriveProxyPort, startProxy } from "./proxy/proxy.js";
import { RoutingTable } from "./proxy/routing.js";
import { createStaticRoutes } from "./proxy/static-routes.js";
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
   * Preferred port the reverse proxy binds on. When set (either via
   * `runtime.proxy_port` in lich.yaml propagated through the auto-start
   * hook, or via the `LICH_PROXY_PORT` env var), this is the port the
   * daemon tries first. When unset, the daemon derives a stable per-
   * worktree port from the resolved LICH_HOME via {@link deriveProxyPort}
   * — same LICH_HOME always yields the same port, different LICH_HOMEs
   * almost certainly yield different ones (LEV-479 Option C).
   *
   * If the preferred port is already taken, the proxy falls back to an
   * OS-assigned port and logs a warning (LEV-479 Option A). The proxy
   * URL is then implicit in the dashboard's `daemon.url` file rather
   * than statically derivable, but friendly URLs continue to work
   * because consumers read the bound port from the daemon state.
   *
   * Pass `0` in tests to force ephemeral port allocation up front
   * (skips the derive + fallback path).
   */
  proxyPort?: number;

  /**
   * Optional directory containing the compiled dashboard SPA assets.
   * When set, the dashboard server serves files from this directory
   * with SPA fallback to `index.html`; when unset, the dashboard root
   * returns a placeholder page (Plan 5 Task 13 lands the real SPA).
   * Tests leave this unset.
   */
  uiDir?: string;

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
 * Resolve the daemon's identity string for {@link deriveProxyPort}
 * — same resolution order as {@link resolveStateRoot} but returns the
 * LICH_HOME ROOT (no `/stacks` suffix) so the derivation is stable
 * across schema changes to the on-disk layout.
 *
 * The identity is whatever directory the daemon's PID/URL files land in:
 *
 *   1. Explicit `opts.lichHome` (used by tests and the auto-start hook)
 *   2. `LICH_HOME` environment variable
 *   3. `~/.lich` (production default)
 *
 * Two daemons with the same identity collide on the same derived port;
 * two daemons with different identities almost certainly don't. The
 * multi-worktree case the issue describes (two test forks, two
 * checkouts) lands in (1) or (2) with distinct tmpdirs, so the derived
 * ports diverge.
 */
function resolveLichHomeIdentity(lichHome: string | undefined): string {
  if (lichHome && lichHome.length > 0) return lichHome;
  const env = process.env.LICH_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), ".lich");
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
 *   - The dashboard server fails to bind (exit 1) — the proxy and
 *     watcher are torn down first so the failure surface is clean
 */
export async function runDaemon(
  opts: RunDaemonOpts = {},
): Promise<RunDaemonResult> {
  const out = opts.out ?? process.stdout;
  // LEV-479: proxy-port precedence (high → low):
  //   1. Explicit `opts.proxyPort` — set by the auto-start hook from
  //      `LICH_PROXY_PORT` env var (Option B) or `runtime.proxy_port`
  //      from lich.yaml (Option B, explicit). When `0` is passed it
  //      stays `0` (ephemeral; tests rely on this).
  //   2. Worktree-derived port — stable hash of the resolved LICH_HOME
  //      path. Same worktree → same port across down/up cycles
  //      (Option C, zero-config default).
  //
  // If the resolved port is then already taken at bind time,
  // `startProxy` falls back to an OS-assigned port (Option A).
  let proxyPort: number;
  if (opts.proxyPort !== undefined) {
    proxyPort = opts.proxyPort;
  } else {
    // Use the resolved LICH_HOME (explicit arg → env → ~/.lich) as the
    // derivation identity. Different worktrees with their own LICH_HOME
    // (the test isolation pattern, also the multi-checkout case the
    // issue describes) deterministically pick different ports. The same
    // home directory always picks the same port across runs.
    const identity = resolveLichHomeIdentity(opts.lichHome);
    proxyPort = deriveProxyPort(identity);
  }
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

  // ---- 4. Initialize routing table from disk -------------------------
  // The proxy reads from this table on every request. We load it once
  // up front so the proxy serves the correct routes from its very first
  // request, then re-load on every watcher tick (see step 6 below).
  const stateRoot = resolveStateRoot(opts.lichHome);
  const routingTable = new RoutingTable();
  await routingTable.reload(stateRoot).catch((err: unknown) => {
    // A first-load failure is non-fatal; the table stays empty and the
    // watcher's onChange will retry on the next state change. Log so
    // operators can see why their friendly URLs 404 if it persists.
    log(
      out,
      `routing table initial load failed: ${(err as Error).message}`,
    );
  });

  // ---- 5. Start the watcher pointed at <LICH_HOME>/stacks ------------
  // The watcher's onChange callback fans the signal out to:
  //   - dashboardServer.refresh() — rebuilds the cached StackView list
  //   - routingTable.reload(stateRoot) — rebuilds the hostname → upstream
  //     map so the proxy reflects the latest disk state on the next
  //     request
  //
  // We assign `dashboardServer` further down (after startDashboardServer
  // returns), but the callback captures the variable lexically, so the
  // closure sees the eventual assignment. Until then, dashboardServer is
  // null and the refresh() call is skipped — which matches the
  // pre-startup window where no requests can land anyway.
  let dashboardServer: DashboardServer | null = null;
  const watcher = new StateWatcher({
    stateRoot,
    onChange: () => {
      // Dashboard refresh is fire-and-forget — the server reads
      // state.json on the next request, so a missed refresh just means
      // the next request triggers the reload.
      if (dashboardServer) {
        dashboardServer.refresh();
      }
      // Routing reload is async; we await with a catch so a transient
      // filesystem error doesn't propagate up as an unhandled rejection
      // and crash the whole daemon. The watcher will fire again on the
      // next state change.
      void routingTable.reload(stateRoot).catch((err: unknown) => {
        log(
          out,
          `routing table reload failed: ${(err as Error).message}`,
        );
      });
    },
  });
  await watcher.start();

  // ---- 6. Start the dashboard HTTP server ----------------------------
  // LEV-481: dashboard now starts BEFORE the proxy so the proxy's
  // static-routes table can include `lich.localhost` → dashboard URL
  // from the very first request. The dashboard already used to follow
  // the proxy in the startup order — flipping them is mechanical
  // (cleanup ordering inverts to match) and conceptually cleaner: the
  // proxy's routing surface is fully known at bind time rather than
  // patched in mid-flight.
  //
  // Bind on an ephemeral port so we never collide with the user's other
  // services. The returned URL is what we write to daemon.url for the
  // auto-start hook to read and present in `lich up`'s summary.
  //
  // Bind failure IS fatal: without a dashboard URL there's nothing to
  // record in daemon.url and no UI for the user to interact with. We
  // clean up the watcher + PID file we've already started, then return
  // a non-zero exit code so the parent observes the failure.
  try {
    dashboardServer = await startDashboardServer({
      port: 0,
      stateRoot,
      uiDir: opts.uiDir,
    });
  } catch (err) {
    log(out, `dashboard failed to start: ${(err as Error).message}`);
    await watcher.stop().catch(() => {});
    await clearDaemonPid(pidOpts).catch(() => {});
    if (opts.lichHome !== undefined) {
      if (prevLichHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevLichHome;
      }
    }
    return { exitCode: 1 };
  }
  log(out, `dashboard listening on ${dashboardServer.url}`);

  // ---- 7. Start the reverse proxy ------------------------------------
  // Bind on the configured port (default 3300, or 0 for tests). A bind
  // failure here is non-fatal — the dashboard can still surface stack
  // state and the user can fall back to `lich urls --raw`. We log a
  // warning and continue without a proxy handle.
  //
  // LEV-481: pass a daemon-wide static-routes table containing the
  // dashboard. `lich.localhost` (the apex of the proxy domain) routes
  // to the dashboard's ephemeral URL — same UX as the per-stack
  // friendly URLs but at a fixed, memorable apex. The dashboard URL is
  // already bound at this point (step 6); the proxy can advertise it
  // from request one.
  const staticRoutes = createStaticRoutes({
    "lich.localhost": dashboardServer.url,
  });
  let proxy: { url: string; stop(): Promise<void> } | null = null;
  try {
    proxy = await startProxy({
      port: proxyPort,
      routingTable,
      staticRoutes,
    });
    log(out, `proxy listening on ${proxy.url}`);
  } catch (err) {
    log(
      out,
      `proxy failed to start on port ${proxyPort}: ${(err as Error).message}`,
    );
  }

  // ---- 8. Publish the dashboard URL ----------------------------------
  // Write the URL file AFTER `Bun.serve` has bound — the auto-start
  // hook (`auto-start.ts`) polls this file with a short timeout to
  // print the URL in `lich up`'s summary. Writing too early would
  // hand out a URL the OS hasn't actually bound yet.
  await writeDaemonUrl(dashboardServer.url, pidOpts);

  // ---- 9. Cleanup machinery (idempotent, race-safe) ------------------
  // Cleanup is gated by `cleanupPromise` so concurrent abort paths
  // (signal abort + SIGTERM + auto-shutdown completing simultaneously)
  // converge on a single in-flight cleanup. All callers await the same
  // promise rather than double-stopping the servers.
  //
  // Stop order: watcher → dashboard → proxy → files. Watcher first so no
  // more refresh/reload callbacks fire mid-teardown into a half-shut
  // dashboard or routing table. Files last so a crash mid-cleanup
  // leaves the failure surface (pid + url files still present, pointing
  // at a process that's gone) for the next `lich up` to clean up via
  // the stale-PID detection path.
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      await watcher.stop().catch(() => {});
      if (dashboardServer) {
        await dashboardServer.stop().catch(() => {});
      }
      if (proxy) {
        await proxy.stop().catch(() => {});
      }
      await clearDaemonUrl(pidOpts).catch(() => {});
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

  // ---- 10. Wire shutdown triggers ------------------------------------
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

  // ---- 11. Auto-shutdown polling loop --------------------------------
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

  // ---- 12. Wait for shutdown -----------------------------------------
  await exitPromise;

  // ---- 13. Final cleanup ---------------------------------------------
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
