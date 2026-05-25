/**
 * Daemon PID file management (LEV-404, Plan 5 Task 2).
 *
 * The lich daemon — a single per-machine process that hosts the dashboard,
 * the reverse proxy, and the state-directory watcher — records its presence
 * via a PID file at `<LICH_HOME>/daemon.pid` (default `~/.lich/daemon.pid`).
 *
 * Subsequent `lich up` invocations check this file to decide whether to
 * spawn a fresh daemon or short-circuit because one is already running.
 * Three possible states drive that decision:
 *
 *   (a) **File absent** — no daemon has ever started, or the last one
 *       shut down cleanly and cleared the file. Start a new daemon.
 *   (b) **File present, PID is alive** — a daemon owns this lich home.
 *       Reuse it; do nothing.
 *   (c) **File present, PID is dead** — a previous daemon crashed (or
 *       was killed by `kill -9` / OOM) without clearing its file. This
 *       function family treats it as "no daemon"; the caller (Task 4 / 5)
 *       is responsible for overwriting the stale file when it starts a
 *       new daemon.
 *
 * ## Atomic writes
 *
 * Writes follow the same atomic-rename pattern as `state/snapshot.ts`:
 * serialize → write to `<file>.<random>.tmp` → `rename()` into place.
 * Rename is atomic on any sane filesystem, so a concurrent reader either
 * sees the previous PID or the new one — never a partial document. This
 * matters because the auto-start logic in Task 5 polls the PID file with
 * a tight loop; a half-written file would crash `parseInt` callers.
 *
 * ## Known limitation: PID reuse
 *
 * `isDaemonAlive` reports true whenever the recorded PID corresponds to a
 * live process — it cannot distinguish "our daemon" from "some other
 * process the OS happens to have assigned the same PID after a reboot or
 * a long-uptime PID-counter wraparound." On modern Unix systems PIDs are
 * 32-bit and wrap rarely (Linux defaults to a 4 million ceiling), so the
 * collision window is small. We accept the false-positive in exchange for
 * a portable, dependency-free check via `process.kill(pid, 0)`. If a
 * caller observes a "running" daemon at the recorded URL that doesn't
 * respond to `/healthz`, that's the signal to treat the PID file as
 * stale and overwrite it.
 *
 * ## LICH_HOME resolution
 *
 * The home directory is resolved in this order, mirroring
 * `state/directory.ts`'s `stateRoot()`:
 *
 *   1. Explicit `opts.lichHome` argument (test isolation)
 *   2. `$LICH_HOME` environment variable (test isolation)
 *   3. `~/.lich` (default)
 *
 * Tests should pass `opts.lichHome` to a tmpdir to keep the real
 * `~/.lich/daemon.pid` untouched. The env var fallback exists for
 * scenarios where the file path needs to be discovered without an
 * explicit options object (e.g. `lich nuke` reading the PID before it
 * has any other context).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PidFileOpts {
  /**
   * Override the LICH_HOME root for this call. When set, the PID file
   * lives at `<lichHome>/daemon.pid`. When unset, falls back to
   * `$LICH_HOME` env or `~/.lich`. Primarily used by tests.
   */
  lichHome?: string;
}

/**
 * Resolve the absolute path to `daemon.pid` for the given options.
 *
 * Mirrors `state/directory.ts`'s LICH_HOME resolution but returns the
 * path to the file directly rather than the stacks root. Splitting out
 * the helper keeps the four public functions trivially symmetric.
 */
function pidFilePath(opts?: PidFileOpts): string {
  if (opts?.lichHome && opts.lichHome.length > 0) {
    return join(opts.lichHome, "daemon.pid");
  }
  const override = process.env.LICH_HOME;
  if (override && override.length > 0) {
    return join(override, "daemon.pid");
  }
  return join(homedir(), ".lich", "daemon.pid");
}

/**
 * Write the daemon's PID to `<LICH_HOME>/daemon.pid` atomically.
 *
 * Creates the parent directory if missing (a fresh machine that has
 * never run lich won't have `~/.lich/` yet). Overwrites any existing
 * file — callers that need stale-detect semantics should call
 * {@link isDaemonAlive} first.
 *
 * Atomicity: serialize → write to `<path>.<random>.tmp` → rename. If
 * the daemon crashes between the writeFile and the rename, the tmp
 * file lingers and the old PID file (if any) is untouched.
 */
export async function writeDaemonPid(
  pid: number,
  opts?: PidFileOpts,
): Promise<void> {
  const dest = pidFilePath(opts);
  await mkdir(dirname(dest), { recursive: true });

  const serialized = `${pid}\n`;
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup of the tmp file. The original `dest` is
    // untouched by a failed rename, so the prior daemon's PID (if any)
    // remains readable.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read the daemon's PID from disk.
 *
 * Returns:
 *   - The parsed integer PID on success.
 *   - `null` when the file is absent (ENOENT).
 *   - `null` when the file exists but its contents don't parse as a
 *     positive integer (malformed: empty, `"not-a-number"`, negative,
 *     fractional, NaN). The daemon has its own self-overwrite path on
 *     startup, so returning `null` for "corrupt" makes callers treat
 *     it as "no daemon" — a safe default.
 *
 * Whitespace tolerance: trailing newline (the standard write format)
 * and arbitrary leading/trailing whitespace are stripped before
 * parsing.
 */
export async function readDaemonPid(
  opts?: PidFileOpts,
): Promise<number | null> {
  const path = pidFilePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Use Number() rather than parseInt() so `"123abc"` is rejected
  // (parseInt would happily return 123). PIDs must be integral and
  // positive — anything else is a corrupt file.
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return pid;
}

/**
 * Probe whether the daemon's recorded PID corresponds to a live process.
 *
 * Implementation: `process.kill(pid, 0)` — signal 0 doesn't actually
 * deliver anything; the kernel just performs the permission check and
 * the existence check, then returns. ESRCH (no such process) means the
 * PID is dead. EPERM means the process exists but we don't own it —
 * still "alive" for our purposes (the daemon should generally be owned
 * by the same user, but it's defensive to handle the rare case where
 * permissions differ).
 *
 * Returns false when:
 *   - {@link readDaemonPid} returns null (no file, or malformed)
 *   - The recorded PID is dead (`process.kill(pid, 0)` throws ESRCH)
 *
 * Known limitation (documented at module top): cannot distinguish "our
 * daemon" from "some other process at the same PID after reuse." If
 * this matters, follow up with a `GET /healthz` against the recorded
 * URL — if the response shape doesn't match the daemon's, treat the
 * PID file as stale.
 */
export async function isDaemonAlive(opts?: PidFileOpts): Promise<boolean> {
  const pid = await readDaemonPid(opts);
  if (pid === null) return false;

  try {
    // Signal 0 = existence check, not a real signal. Throws on dead PID
    // (ESRCH) or other systemic failure (rare). EPERM = process exists
    // but isn't ours; counts as alive for the daemon-check purpose.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Remove the PID file. Idempotent — succeeds silently when the file is
 * already absent (ENOENT).
 *
 * Called by the daemon's SIGTERM cleanup, and by `lich nuke` after it
 * has SIGTERM'd the daemon process so the next `lich up` starts from a
 * clean slate.
 */
export async function clearDaemonPid(opts?: PidFileOpts): Promise<void> {
  const path = pidFilePath(opts);
  // `rm` with `force: true` is the idempotent flavor — returns
  // undefined on missing file rather than ENOENT.
  await rm(path, { force: true });
}
