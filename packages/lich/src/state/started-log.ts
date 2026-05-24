/**
 * Append-only NDJSON log of every external resource lich has spawned
 * (LEV-311).
 *
 * Per-stack `state.json` is the cheap, structured source of truth for
 * normal teardown — but it can get out of sync with reality (crash
 * mid-up, `kill -9`, manual `rm`, weird user testing). When it does,
 * the external resources (containers, host processes, supabase project
 * stores) leak. `lich nuke` reads state.json, finds nothing to do, and
 * those orphans live forever.
 *
 * This module is the recovery escape hatch. Every time lich spawns
 * something that creates external state — an owned long-lived process,
 * a oneshot, a compose project — we append one NDJSON line here with
 * enough context to reconstruct cleanup later. `lich nuke --rescue`
 * (LEV-311 / `commands/nuke.ts`) reads the log and runs cleanup per
 * entry, idempotently.
 *
 * Properties:
 *
 *   - **Single file.** `${stateRoot()}/started.log`. One log per machine
 *     covers every stack — there is no "this stack's log" because the
 *     point of rescue is to clean up state that's already untethered
 *     from any specific stack dir.
 *
 *   - **Append-only.** Writes go through `fs.appendFile`. On POSIX this
 *     opens with `O_APPEND`, which makes per-line writes atomic across
 *     concurrent processes — two parallel `lich up` calls won't
 *     interleave their JSON payloads mid-line. (Lines < `PIPE_BUF` —
 *     typically 4096 on Linux/macOS — are guaranteed atomic. Our
 *     entries are well under that.)
 *
 *   - **Partial-tolerant.** Each line ends with `\n`. If lich crashed
 *     mid-write the trailing line may be truncated; the parser drops
 *     malformed lines (logging a single stderr warning) and continues.
 *     A valid line followed by a partial last line is read correctly.
 *
 *   - **No tombstoning.** We don't record "this got cleaned up." Cleanup
 *     ops are idempotent (SIGTERM on a dead pid = ESRCH = no-op, compose
 *     down on a stopped project = no-op, supabase stop on an absent
 *     project = no-op). Re-running rescue is safe.
 *
 *   - **No pruning in v1.** Log grows forever. If it ever becomes a
 *     real problem (>10 MB), a future ticket can add "on lich up, drop
 *     entries whose stack is Done and > N days old." Out of scope here.
 */

import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateRoot } from "./directory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One line of the started-log. The `kind` discriminates between the
 * three resource shapes the rescue code paths know how to clean up.
 *
 * `pid` — a long-lived owned process. `pid` is the lich-spawned child's
 * PID at startup; `cmd` and `cwd` are stored for diagnostics (and for
 * future rescues that might want to display them in the summary).
 * Cleanup: SIGTERM, grace, SIGKILL if still alive.
 *
 * `compose` — a compose project lich invoked `up` on. `project` is the
 * compose project name (`lich-<stack_id>` per the runner convention);
 * `files` is the list of `-f` paths passed to compose; `cwd` is the
 * cwd compose was invoked from. `compose_cli` records which CLI was
 * used so rescue can pick the matching one (and fall back to autodetect
 * if that CLI is no longer available). Cleanup: `compose down -v
 * --remove-orphans -p <project>` with the logged files.
 *
 * `owned` — an owned service (long-lived OR oneshot) with everything
 * needed to invoke its `stop_cmd` from a fresh process. `env` is the
 * RESOLVED env (post-interpolation, post-env_from), captured at spawn
 * time, so rescue's `stop_cmd` sees the same SUPABASE_PROJECT_ID etc.
 * the start side saw — critical for supabase-style tools that key
 * external state by an interpolated project id. Cleanup: spawn
 * `/bin/sh -c <stop_cmd>` with `cwd: entry.cwd, env: entry.env`.
 *
 * For long-lived owned services we log BOTH a `pid` entry and an
 * `owned` entry: the pid entry is the direct-kill path, the owned
 * entry is the stop_cmd path. Either alone would miss cases.
 */
export type StartedEntry =
  | {
      ts: string;
      stack_id: string;
      kind: "pid";
      service: string;
      pid: number;
      cmd: string;
      cwd: string;
    }
  | {
      ts: string;
      stack_id: string;
      kind: "compose";
      project: string;
      files: string[];
      cwd: string;
      compose_cli: "docker" | "podman" | "nerdctl";
    }
  | {
      ts: string;
      stack_id: string;
      kind: "owned";
      service: string;
      cmd: string;
      stop_cmd?: string;
      cwd: string;
      env: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the started log. Lives under `stateRoot()/..` so
 * `~/.lich/started.log` (or `$LICH_HOME/started.log` when overridden
 * for tests). Keeping it OUT of `~/.lich/stacks/` matters: rm-rf of the
 * stacks dir (which is the symptom rescue exists to recover from) must
 * not also nuke the rescue log.
 */
export function startedLogPath(): string {
  // stateRoot() returns `<lich-home>/stacks`. Step up one level for the
  // log file so it survives `rm -rf <stacks>`. dirname() is the
  // platform-correct way to do this.
  return join(dirname(stateRoot()), "started.log");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Append a single entry as one NDJSON line.
 *
 * `appendFile` opens with `O_APPEND` on POSIX — concurrent writers are
 * serialized at the kernel level for writes under `PIPE_BUF` (typically
 * 4096), so two parallel `lich up` calls will produce two complete
 * lines, never a torn interleave. Our entries are well under that even
 * with a chunky resolved env map.
 *
 * Ensures the parent directory exists once at module init (cheaper than
 * an mkdir on every call, but we also keep a per-write recovery in case
 * the directory was deleted between calls — the rescue use case is
 * literally "someone rm-rf'd ~/.lich/").
 */
export async function appendStarted(entry: StartedEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  const path = startedLogPath();
  try {
    await appendFile(path, line, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Parent dir is gone (rm-rf'd, fresh machine). Create it and
      // retry once. Using the sync version here keeps the retry tight
      // — appendFile's own create-on-write doesn't help when the parent
      // dir itself doesn't exist.
      mkdirSync(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Slurp and parse the entire started log.
 *
 * Returns `[]` if the file doesn't exist (fresh machine, never up'd
 * anything). Splits on `\n`, parses each non-empty line as JSON. Lines
 * that fail to parse — truncated tails from a crash mid-write, junk
 * appended manually, etc. — are dropped and counted; if any are
 * dropped we emit a single warning to stderr so the operator knows
 * the log isn't fully readable.
 *
 * Type validation is best-effort: we cast to `StartedEntry` after JSON
 * parse rather than running each parsed object through a runtime schema.
 * The rescue code handles all three discriminator cases and ignores
 * entries whose `kind` doesn't match — and we control every writer, so
 * malformed shape is far less likely than truncated line at end of
 * file.
 */
export async function readStartedLog(): Promise<StartedEntry[]> {
  const path = startedLogPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const entries: StartedEntry[] = [];
  let dropped = 0;
  // Split on `\n` — every well-formed line ends with one, so the
  // last element is "" for a clean file. A truncated final write
  // (no trailing `\n`) leaves the partial JSON as the last element,
  // which JSON.parse will throw on; that gets counted in `dropped`.
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as StartedEntry;
      entries.push(parsed);
    } catch {
      dropped++;
    }
  }

  if (dropped > 0) {
    // One warning, regardless of count. Goes to stderr so it doesn't
    // pollute structured stdout (e.g. `lich stacks --json`). The
    // rescue summary will be on stdout; this is operator-facing
    // context about the input's integrity.
    process.stderr.write(
      `lich: skipped ${dropped} malformed line${dropped === 1 ? "" : "s"} in started.log\n`,
    );
  }

  return entries;
}
