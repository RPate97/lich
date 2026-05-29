/**
 * Append-only NDJSON log of every external resource lich has spawned,
 * used by `lich nuke --rescue` to recover when state.json gets out of
 * sync (crash mid-up, `kill -9`, manual rm).
 *
 * Lives at `<lich-home>/started.log` (outside `stacks/`, so `rm -rf stacks/`
 * doesn't nuke it). `appendFile` on POSIX uses `O_APPEND`, so concurrent
 * writers don't tear lines (entries are well under PIPE_BUF).
 *
 * Cleanup ops are idempotent — re-running rescue is safe.
 */

import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateRoot } from "./directory.js";

/**
 * One started-log line. For long-lived owned services we log BOTH a `pid`
 * entry (direct-kill path) AND an `owned` entry (stop_cmd path); either
 * alone would miss cases. The owned `env` is post-interpolation so
 * `stop_cmd` sees the same env (e.g. SUPABASE_PROJECT_ID) the start saw.
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

/** Absolute path to the started log. Outside `stacks/` so it survives `rm -rf stacks/`. */
export function startedLogPath(): string {
  return join(dirname(stateRoot()), "started.log");
}

/** Append one entry as one NDJSON line. */
export async function appendStarted(entry: StartedEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  const path = startedLogPath();
  try {
    await appendFile(path, line, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // parent dir rm-rf'd between calls — recreate and retry once
      mkdirSync(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
      return;
    }
    throw err;
  }
}

/** Read and parse the started log. Returns `[]` if missing; drops malformed lines with a stderr warning. */
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
    // stderr so structured stdout (e.g. `lich stacks --json`) stays clean
    process.stderr.write(
      `lich: skipped ${dropped} malformed line${dropped === 1 ? "" : "s"} in started.log\n`,
    );
  }

  return entries;
}
