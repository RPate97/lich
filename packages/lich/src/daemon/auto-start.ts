/**
 * Daemon auto-start hook for `lich up` (LEV-407, Plan 5 Task 5).
 *
 * `lich up` calls {@link ensureDaemonRunning} once per invocation to make
 * sure the per-machine lich daemon is alive. The daemon hosts the
 * dashboard, the reverse proxy, and the state-directory watcher — pieces
 * that have to outlive any one `lich up` because they serve multiple
 * parallel stacks and survive across `lich up` / `lich down` cycles.
 *
 * The two paths:
 *
 *   1. **Daemon already running** — `isDaemonAlive()` returns true (the
 *      PID file points at a live process). Read the URL file and return
 *      `{ url, alreadyRunning: true }`. ~10ms; the 99% case once the
 *      first `lich up` of the session has fired.
 *   2. **Daemon not running** — spawn `dist/lich-daemon` as a detached
 *      child, then poll the URL file. The spawn uses `detached: true` +
 *      `unref()` so the daemon outlives this very process (`lich up`
 *      exits as soon as the stack is ready; the daemon must persist).
 *      Returns `{ url, alreadyRunning: false }` once the URL appears.
 *
 * Why not unconditionally spawn? Cold-start cost. The daemon takes
 * ~200–500ms to boot (Bun startup + `Bun.serve` bind). Re-paying that on
 * every `lich up` would dwarf the work the user actually asked for. The
 * `isDaemonAlive()` short-circuit is what keeps the second-and-onward
 * `lich up` calls feeling instant.
 *
 * ## Binary location resolution
 *
 * The daemon is its own binary at `dist/lich-daemon` (built by the
 * `build:daemon` package.json script). Two resolution strategies:
 *
 *   1. **Sibling-of-current-binary** — `dirname(process.execPath) +
 *      "/lich-daemon"`. The common case: when `lich` is run from
 *      `dist/lich`, the daemon binary sits beside it at `dist/lich-daemon`.
 *      This works for the production install and for any local build that
 *      keeps the two binaries together.
 *   2. **`LICH_DAEMON_BIN` env-var override** — explicit absolute path.
 *      Used by:
 *        - Tests that point at a fake shell script standing in for the
 *          real daemon (so we can verify spawn behavior without compiling).
 *        - Dev workflows that build to non-standard locations.
 *
 * Resolution order is env-first (override beats inference); if neither
 * yields a runnable binary, we throw a clear error explaining both
 * expected paths. The thrown error is allowed to bubble — callers should
 * treat "no daemon binary" as a hard configuration error.
 *
 * ## Browser open is best-effort
 *
 * When `openBrowser` is true AND we just spawned a fresh daemon, we try
 * to open the dashboard URL in the user's default browser via the
 * platform's URL handler (`open` on macOS, `xdg-open` on Linux, `start`
 * on Windows). Failure (handler not present, browser refuses, etc.) is
 * silent — the user sees the URL in the `lich up` summary regardless
 * and can paste it manually. We never re-open the browser when a daemon
 * is already running (`alreadyRunning: true`); that would be annoying
 * the second time the user runs `lich up`.
 *
 * ## Timeout behavior
 *
 * The polling loop has a default `timeoutMs` of 10s. If the URL file
 * never appears we throw a clear error. The PID file's appearance is
 * NOT the trigger — the daemon may have written the PID file but
 * crashed before `Bun.serve` bound. The URL file is the readiness
 * marker. Tests use a much shorter timeout (1s) so the failure path
 * doesn't drag on.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";

import { isDaemonAlive, readDaemonUrl } from "./pid-file.js";

/**
 * Options for {@link ensureDaemonRunning}.
 *
 * All fields are optional; the defaults match production usage.
 */
export interface AutoStartOpts {
  /**
   * Override the LICH_HOME root. When set, the daemon is started with
   * `LICH_HOME=<lichHome>` in its env so PID/URL files land under that
   * root rather than `~/.lich`. Primarily used by tests to isolate
   * filesystem effects to a tmpdir.
   */
  lichHome?: string;

  /**
   * Port the daemon should bind its reverse proxy on. Forwarded as
   * `LICH_PROXY_PORT` to the spawned daemon. When unset, the daemon
   * uses its own default (3300).
   */
  proxyPort?: number;

  /**
   * Open the dashboard URL in the user's default browser after a fresh
   * daemon spawn. Ignored when the daemon was already running — opening
   * the browser on every `lich up` would be hostile UX. Best-effort:
   * failures are logged (to `out`) but don't fail the hook.
   */
  openBrowser?: boolean;

  /**
   * Writable stream for diagnostic messages (browser-open failures,
   * spawn warnings). Defaults to `process.stdout`. Tests pass a
   * capture-friendly buffer-backed stream.
   */
  out?: NodeJS.WritableStream;

  /**
   * Maximum time to wait for the URL file to appear after spawning the
   * daemon. Defaults to 10s. Tests use a tighter value (e.g. 1s) to
   * keep the timeout-path test from dragging.
   */
  timeoutMs?: number;

  /**
   * Poll interval for the URL file. Defaults to 50ms — fast enough that
   * the typical ~300ms boot is caught within one or two polls, slow
   * enough that we don't burn CPU on a hot loop.
   */
  pollIntervalMs?: number;
}

/**
 * Result of {@link ensureDaemonRunning}.
 *
 *   - `url`: the dashboard URL the daemon advertises (e.g.
 *     `http://127.0.0.1:54321`). Always present on success.
 *   - `alreadyRunning`: true when the daemon was already alive on entry;
 *     false when this call spawned a fresh one. Callers use this to
 *     decide whether to print "started daemon at <url>" vs "daemon at
 *     <url>" in the `lich up` summary, and to gate one-time UX (e.g.
 *     browser open).
 */
export interface AutoStartResult {
  url: string;
  alreadyRunning: boolean;
}

/** Default URL-file poll deadline — generous enough for cold-start Bun. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default URL-file poll interval. ~200 polls in the worst-case 10s window. */
const DEFAULT_POLL_INTERVAL_MS = 50;

/**
 * Ensure the lich daemon is running, spawning it if necessary, and
 * return its dashboard URL.
 *
 * On success the daemon is alive (either pre-existing or freshly
 * spawned) AND its URL file is present. The returned URL is suitable
 * for both the `lich up` summary block and the browser-open call.
 *
 * On failure:
 *   - Binary not found → throws with a clear "where we looked" message.
 *     This is a hard configuration error; the caller cannot recover.
 *   - URL file never appears (timeout) → throws explaining the daemon
 *     spawn appears to have failed. Callers in `lich up` should catch
 *     this and degrade gracefully (print a warning, don't fail the
 *     stack-up that already succeeded).
 */
export async function ensureDaemonRunning(
  opts: AutoStartOpts = {},
): Promise<AutoStartResult> {
  const out = opts.out ?? process.stdout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pidOpts =
    opts.lichHome !== undefined ? { lichHome: opts.lichHome } : undefined;

  // ---- 1. Fast path: daemon already running --------------------------
  // The 99% case once the first `lich up` of the session has run. We
  // check isDaemonAlive (PID file points at a live process) AND that
  // the URL file is present. If only the PID is alive but the URL is
  // missing, the previous daemon crashed mid-startup — treat as "no
  // daemon" and proceed to spawn.
  if (await isDaemonAlive(pidOpts)) {
    const existingUrl = await readDaemonUrl(pidOpts);
    if (existingUrl !== null) {
      return { url: existingUrl, alreadyRunning: true };
    }
    // Daemon alive but no URL — a fresh daemon started but hasn't
    // written its URL yet. Wait for it; don't spawn a duplicate.
    const url = await pollForUrl(pidOpts, timeoutMs, pollIntervalMs);
    return { url, alreadyRunning: true };
  }

  // ---- 2. Spawn path: no daemon, fire one up -------------------------
  const binaryPath = resolveDaemonBinary();

  // Build env for the spawned daemon. Start from the parent's env so
  // PATH and friends propagate, then layer LICH_HOME + LICH_PROXY_PORT
  // on top so the daemon binds the test-isolated state directory.
  const childEnv: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (opts.lichHome !== undefined) {
    childEnv.LICH_HOME = opts.lichHome;
  }
  if (opts.proxyPort !== undefined) {
    childEnv.LICH_PROXY_PORT = String(opts.proxyPort);
  }

  // detached: true → child gets its own process group, can outlive us.
  // stdio: "ignore" → daemon's stdout/stderr go nowhere from our view
  //   (the daemon writes its own log files; we don't want to inherit
  //   its open TTYs into the parent `lich up` summary).
  // unref() → don't let the child handle keep this event loop alive.
  //   Without this, `lich up` would hang waiting for the daemon child
  //   to exit (which it never will until auto-shutdown).
  const child = spawn(binaryPath, [], {
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  child.unref();

  // The child may fire 'error' synchronously (ENOENT for binary, no
  // exec permissions) — turn that into a thrown error from this hook so
  // the caller doesn't sit through the full timeoutMs polling for a URL
  // file that's never coming. Note: we attach the listener immediately
  // and let the spawn proceed; if 'error' fires later (asynchronously)
  // the pollForUrl timeout is the safety net.
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err;
  });

  // ---- 3. Wait for URL file ------------------------------------------
  let url: string;
  try {
    url = await pollForUrl(pidOpts, timeoutMs, pollIntervalMs);
  } catch (err) {
    // Surface spawn-error if one was captured during the wait. Falls
    // back to the original timeout error otherwise.
    if (spawnError !== null) {
      throw new Error(
        `lich daemon failed to start: ${(spawnError as Error).message}`,
      );
    }
    throw err;
  }

  // ---- 4. Optional browser open --------------------------------------
  // Best-effort. We never re-open when reusing a running daemon — that
  // gate is handled by the early return above.
  if (opts.openBrowser === true) {
    try {
      openInBrowser(url);
    } catch (err) {
      // Already best-effort, but a thrown synchronous error (e.g.
      // platform we don't handle) gets logged so the user can see why.
      out.write(
        `[lich] warning: could not open browser: ${(err as Error).message}\n`,
      );
    }
  }

  return { url, alreadyRunning: false };
}

/**
 * Resolve the path to the `lich-daemon` binary.
 *
 * Resolution order:
 *   1. `LICH_DAEMON_BIN` env var (test + dev override)
 *   2. Sibling of `process.execPath` named `lich-daemon`
 *
 * Throws when neither yields an existing file. The error message lists
 * both paths we looked at so the caller can fix the install layout.
 */
function resolveDaemonBinary(): string {
  const envOverride = process.env.LICH_DAEMON_BIN;
  if (envOverride !== undefined && envOverride.length > 0) {
    if (existsSync(envOverride)) {
      return envOverride;
    }
    throw new Error(
      `lich-daemon binary not found at LICH_DAEMON_BIN=${envOverride}`,
    );
  }

  // process.execPath for a Bun-compiled `lich` binary points at the
  // binary itself; for `bun run src/...` it points at the Bun runtime.
  // Either way, the sibling path is the canonical location of the
  // adjacent `lich-daemon` binary in a production install.
  const sibling = join(dirname(process.execPath), "lich-daemon");
  if (existsSync(sibling)) {
    return sibling;
  }

  throw new Error(
    `lich-daemon binary not found at ${sibling}` +
      ` (and LICH_DAEMON_BIN env var is unset).` +
      ` Build it with: cd packages/lich && bun run build:daemon`,
  );
}

/**
 * Poll for the daemon URL file every `pollIntervalMs` until it appears
 * or the deadline elapses. Returns the URL on success; throws on
 * timeout.
 *
 * The error message includes the elapsed time and the LICH_HOME we were
 * checking so the caller can diagnose where to look.
 */
async function pollForUrl(
  pidOpts: { lichHome?: string } | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  // Try once before the first sleep — covers the case where the daemon
  // is already-up-but-we-raced-to-check (e.g. another `lich up` started
  // it half a second ago and we slipped past the alive check).
  const initial = await readDaemonUrl(pidOpts);
  if (initial !== null) return initial;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    const url = await readDaemonUrl(pidOpts);
    if (url !== null) return url;
  }

  const home = pidOpts?.lichHome ?? process.env.LICH_HOME ?? "~/.lich";
  throw new Error(
    `timeout waiting for lich daemon URL file in ${home} after ${timeoutMs}ms` +
      ` (the daemon spawn appears to have failed)`,
  );
}

/**
 * Open `url` in the user's default browser via the platform's URL
 * handler.
 *
 * Throws if the platform isn't handled (we cover darwin, linux, win32);
 * the spawned process's own failures are silent (best-effort per the
 * docstring above).
 */
function openInBrowser(url: string): void {
  const plat = platform();
  let command: string;
  if (plat === "darwin") {
    command = "open";
  } else if (plat === "linux") {
    command = "xdg-open";
  } else if (plat === "win32") {
    command = "start";
  } else {
    throw new Error(`unsupported platform for browser open: ${plat}`);
  }

  // Detached + ignored stdio: we don't want the browser process tied to
  // our event loop. Errors fire on the child (silent) rather than
  // throwing synchronously.
  const child = spawn(command, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
