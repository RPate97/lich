/**
 * Dashboard action endpoints: shell out to the `lich` CLI from the daemon
 * (LEV-418, Plan 5 Task 16).
 *
 * The dashboard's "Stop" and "Restart" buttons POST to
 * `/api/stacks/:id/stop` and `/api/stacks/:id/restart`. The server handler
 * looks up the target stack's worktree path from its `state.json` snapshot
 * and calls {@link runLichAction} to spawn the appropriate `lich`
 * subprocess in that worktree.
 *
 * ## Why shell out instead of importing `runDown` / `runRestart` directly
 *
 * The daemon is a long-running process. The CLI commands assume they own
 * the process — they install SIGINT/SIGTERM handlers, manage process-group
 * lifecycles for owned services, and (more subtly) read `process.cwd()` /
 * `process.env` at points the daemon can't reliably control. Spawning a
 * fresh `lich` subprocess for each action keeps the CLI's process-owns-the-
 * world assumption intact and makes the action behavior identical to what a
 * human would see typing `lich down` in the worktree's directory.
 *
 * It also gives us a clean exit-code contract: the subprocess's exit code
 * is what the dashboard's HTTP response carries. No try/catch hierarchy
 * to map exceptions to exit codes; the OS already did that work.
 *
 * ## Binary location resolution
 *
 * Mirrors `daemon/auto-start.ts`'s pattern for the daemon binary:
 *
 *   1. `LICH_BIN` env-var override — explicit absolute path. Used by tests
 *      that point at a fake shell script standing in for the real CLI.
 *   2. Sibling of `process.execPath` named `lich`. For a Bun-compiled
 *      `lich-daemon` binary this resolves to `dist/lich` (the two binaries
 *      sit beside each other in `dist/`).
 *
 * Env-first so tests can override without rebuilding. Throws on resolution
 * failure rather than returning a {@link ActionResult} with `ok: false` —
 * the missing-binary case is a hard configuration error the operator must
 * fix; surfacing it as a thrown error lets the server handler convert it
 * to a 500 response while still returning structured 200 results for the
 * (much more common) subprocess-completed-with-nonzero-exit case.
 *
 * ## Output capping
 *
 * Both stdout and stderr are capped at {@link OUTPUT_CAP_BYTES} (16KB) per
 * stream. A chatty `lich down` (compose teardown stderr, supabase logs,
 * etc.) can easily dump megabytes; without the cap the JSON response would
 * choke the UI. When the cap is exceeded we keep the FIRST N bytes (the
 * tail is usually the most useful but the head includes the command's
 * own banner/setup output which is what users see in the dashboard's
 * "result" panel) and append a sentinel newline noting the truncation.
 *
 * ## Timeout
 *
 * Default 5 minutes ({@link DEFAULT_TIMEOUT_MS}). `lich down` is typically
 * a few seconds, but `restart` on the dogfood stack includes a full
 * supabase teardown + restart which can creep toward a minute on slow
 * machines. The action endpoint isn't user-blocking — the dashboard
 * polls — so a generous ceiling keeps real teardowns from being killed
 * mid-flight while still preventing a wedged subprocess from hanging
 * forever.
 *
 * On timeout we SIGKILL the subprocess (no SIGTERM grace — the timeout
 * already represents "took way too long"; further grace just doubles
 * the wait) and return `{ ok: false, exitCode: -1, stderr: '... timed
 * out after Xs' }`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Outcome of a single {@link runLichAction} call. Mirrors the wire format
 * the dashboard's POST handlers return in their JSON body.
 *
 *   - `ok`: convenience — true iff `exitCode === 0`. The dashboard UI
 *     branches on this for the result panel's green/red styling.
 *   - `exitCode`: the subprocess's exit code, or `-1` when the subprocess
 *     couldn't run to completion (timeout, killed by signal).
 *   - `stdout` / `stderr`: captured (and possibly truncated) output.
 */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Options for {@link runLichAction}. All fields are optional; the defaults
 * match production usage from the dashboard's POST handlers.
 */
export interface RunLichActionOpts {
  /**
   * Max time (ms) to wait for the subprocess to complete. SIGKILL on
   * expiry. Defaults to {@link DEFAULT_TIMEOUT_MS} (5 minutes). Tests
   * pass a much shorter value (e.g. 500ms) to exercise the timeout path.
   */
  timeoutMs?: number;
}

/** Default timeout — accommodates supabase-style teardowns. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-stream output cap. 16KB chosen to match the v0 dashboard's
 * actions.ts capacity and to keep the JSON response under typical
 * HTTP/proxy buffer sizes.
 */
const OUTPUT_CAP_BYTES = 16 * 1024;

/**
 * Sentinel suffix appended when output gets truncated. Picked to be
 * grep-friendly and instantly recognizable in the UI's result panel.
 */
const TRUNCATION_SUFFIX = "\n[... output truncated]\n";

/**
 * Run `lich <action>` in the given worktree, capturing stdout/stderr and
 * returning the result as an {@link ActionResult}.
 *
 * Never throws on subprocess failure (non-zero exit, child error, signal
 * termination) — those are returned as `{ ok: false, ... }` so the
 * dashboard handler can ship them back as a 200 response with structured
 * detail. The dashboard wants to render "your action ran and here's what
 * happened" rather than masking the failure as a generic server error.
 *
 * THROWS only for hard configuration errors — specifically when the lich
 * binary itself can't be located. The server handler should treat a
 * thrown error here as 500 Internal Server Error.
 */
export async function runLichAction(
  worktreePath: string,
  action: "down" | "restart",
  opts: RunLichActionOpts = {},
): Promise<ActionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const binaryPath = resolveLichBinary();

  return new Promise<ActionResult>((resolve) => {
    // Buffered output collectors. We accumulate raw bytes (not decoded
    // strings) so the cap math is exact regardless of multibyte
    // characters — a single character that crosses the cap boundary
    // would be ambiguous otherwise.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Set up the child env. Start from the parent (daemon) env so PATH,
    // LICH_HOME, LICH_PROXY_PORT etc. propagate to the spawned CLI. The
    // CLI uses LICH_HOME from its own env to find the right state
    // directory — without propagation, the spawned `lich down` would
    // look at `~/.lich` instead of the daemon's (potentially test-
    // isolated) home and find nothing.
    const childEnv = { ...process.env };

    let child;
    try {
      child = spawn(binaryPath, [action], {
        cwd: worktreePath,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // detached: true makes the child a process-group leader so we
        // can SIGKILL the whole group on timeout. Without this, killing
        // the shell wrapper leaves long-running grandchildren (e.g. a
        // `sleep 30` started from a shell-script `lich` mock) holding
        // the stdio pipes open, which prevents `close` from firing and
        // wedges the timeout path. Mirrors `owned/supervisor.ts`'s
        // signal-the-group pattern.
        detached: true,
      });
    } catch (err) {
      // Synchronous spawn failure (rare; usually ENOENT/EACCES on the
      // binary itself — but resolveLichBinary already guards EXISTS).
      // Return a structured failure rather than throwing — same shape
      // as a non-zero exit so the dashboard renders consistently.
      resolve({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `failed to spawn lich: ${(err as Error).message}`,
      });
      return;
    }

    // ----- Timeout watchdog ---------------------------------------------
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // SIGKILL (not SIGTERM): the timeout's already a generous
      // ceiling, and the user just clicked a button that's now
      // wedged — get out of their way.
      //
      // Signal the whole process group (negative pid) so grandchildren
      // (a shell-wrapped `sleep 30` mock; a real `compose down`
      // backgrounding subprocesses) get reaped too. Without the group
      // signal, a wedged grandchild keeps holding the inherited stdio
      // pipes, `close` never fires, and we leak. See the `detached:
      // true` rationale above for the matching half of this fix.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // ESRCH if the group already exited; fall back to the per-pid
        // signal in case the group didn't actually form (rare, but
        // safer to double-tap than leak).
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
    }, timeoutMs);

    // ----- Capture stdout -----------------------------------------------
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= OUTPUT_CAP_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = OUTPUT_CAP_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        // Partial keep — slice to the cap, mark truncated.
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = OUTPUT_CAP_BYTES;
        stdoutTruncated = true;
      }
    });

    // ----- Capture stderr -----------------------------------------------
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= OUTPUT_CAP_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = OUTPUT_CAP_BYTES - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = OUTPUT_CAP_BYTES;
        stderrTruncated = true;
      }
    });

    // ----- Error path (e.g. ENOENT after async spawn) -------------------
    // `error` fires for things like the binary being unexecutable or
    // disappearing between resolveLichBinary's existsSync check and the
    // actual exec. Capture as a structured failure.
    let errored = false;
    child.once("error", (err: Error) => {
      errored = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `lich subprocess error: ${err.message}`,
      });
    });

    // ----- Exit path ----------------------------------------------------
    // `close` (not `exit`) so stdout/stderr drains are flushed before we
    // resolve — without this, the last few bytes of output can race the
    // exit event and get lost.
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (errored) return; // already resolved via the error handler
      clearTimeout(timeout);

      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stdoutTruncated) stdout += TRUNCATION_SUFFIX;
      if (stderrTruncated) stderr += TRUNCATION_SUFFIX;

      if (timedOut) {
        // The exit happened because we SIGKILLed. Surface a useful
        // diagnostic in stderr so the UI can show why the action
        // didn't complete. Stick to exitCode: -1 to match the
        // "couldn't run to completion" semantic.
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[lich daemon] action timed out after ${timeoutMs}ms\n`,
        });
        return;
      }

      // Signal-terminated subprocesses don't have an exit code; surface
      // -1 and note the signal in stderr so it's visible to the user.
      if (code === null) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[lich daemon] action terminated by signal: ${signal ?? "unknown"}\n`,
        });
        return;
      }

      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the `lich` CLI binary.
 *
 * Resolution order (matches `daemon/auto-start.ts`):
 *   1. `LICH_BIN` env var (test + dev override)
 *   2. Sibling of `process.execPath` named `lich`
 *
 * Throws when neither yields an existing file. The error message lists
 * both paths we looked at so the operator can fix the install layout.
 *
 * Exported for the server's binary-resolution probe — the server uses
 * it to fail fast at startup if the binary is missing rather than
 * waiting for the first action request.
 */
export function resolveLichBinary(): string {
  const envOverride = process.env.LICH_BIN;
  if (envOverride !== undefined && envOverride.length > 0) {
    if (existsSync(envOverride)) {
      return envOverride;
    }
    throw new Error(`lich binary not found at LICH_BIN=${envOverride}`);
  }

  // process.execPath for a Bun-compiled `lich-daemon` binary points at
  // the binary itself; for `bun run src/...` it points at the Bun
  // runtime. Either way, the sibling path is the canonical location of
  // the adjacent `lich` binary in a production install.
  const sibling = join(dirname(process.execPath), "lich");
  if (existsSync(sibling)) {
    return sibling;
  }

  throw new Error(
    `lich binary not found at ${sibling}` +
      ` (and LICH_BIN env var is unset).` +
      ` Build it with: cd packages/lich && bun run build`,
  );
}
