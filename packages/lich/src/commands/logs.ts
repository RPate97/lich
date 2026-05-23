/**
 * `lich logs [service]` — read per-service log files from the state directory.
 *
 * Reads `~/.lich/stacks/<stack_id>/logs/<service>.log` (one file per service,
 * compose or owned — written by the supervisor / compose log forwarder).
 *
 * Modes:
 *   - No service arg → aggregate all services in the snapshot, prefixing
 *     every emitted line with `[<service>] `.
 *   - With a service arg → stream just that one service; no prefix.
 *
 * Flags:
 *   - `--follow` (default ON) → after writing the initial tail, poll the
 *     file(s) and emit new bytes as they're appended.
 *   - `--no-follow` → print existing content and exit immediately.
 *   - `--tail N` → limit initial output to the last N lines per service.
 *     Defaults: 50 with follow, 200 without follow.
 *
 * Plan 1 simplifications:
 *   - "Last N lines" is implemented by reading the whole file and taking
 *     the last N. Logs are bounded by the lifetime of a stack so this is
 *     fine for v1; a Plan 4+ optimization can re-do it without re-reading.
 *   - Polling uses stat + read-with-offset on the same shape as
 *     `src/ready/log-match.ts`. We don't bother with inotify / FSEvents.
 *   - If a log file doesn't exist yet (service hasn't logged anything), we
 *     treat it as empty and (in follow mode) keep polling for it to appear.
 *
 * Resolution:
 *   - The stack is identified by walking up from `cwd` to find `lich.yaml`,
 *     then deriving the stack id via {@link detectWorktree}. If there's no
 *     lich.yaml OR no `state.json` for the resulting stack, we print
 *     "no stack found for this worktree" and exit 1.
 *   - An unknown service name (not in the snapshot's services list) prints
 *     an error listing the available service names and exits 1.
 *
 * The CLI dispatcher will wire this into `commands/index.ts` later (in a
 * single cleanup commit after multiple Plan 1 commands land). For now this
 * file is self-contained and callable as a library from tests.
 */

import { open, stat } from "node:fs/promises";

import { serviceLogPath } from "../state/directory.js";
import { readSnapshot, type StackSnapshot } from "../state/snapshot.js";
import { detectWorktree } from "../worktree/detect.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunLogsInput {
  /** Optional service filter. If omitted, all services are aggregated. */
  service?: string;
  /** Follow mode (poll-tail). Defaults handled by CLI dispatch. */
  follow: boolean;
  /** Initial tail size in lines per service. */
  tail: number;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /**
   * AbortSignal for follow mode. The real CLI wires SIGINT to this; tests
   * pass an AbortController to terminate the poll loop deterministically.
   */
  signal?: AbortSignal;
}

export interface RunLogsResult {
  /**
   * Process exit code. The value is finalized once `done` resolves. Until
   * then it reflects the most recent state (0 on the happy path; 1 on any
   * surface-level error like "no stack" or unknown service). Implemented
   * as a getter so callers can read it after awaiting `done`.
   */
  readonly exitCode: number;
  /**
   * Resolves once the command finishes streaming. For non-follow this is
   * after the initial dump. For follow it resolves when the abort signal
   * fires (or the loop exits for any other reason — it normally only
   * exits on abort).
   */
  done: Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults / constants
// ---------------------------------------------------------------------------

/** Default poll interval for follow mode. Matches `ready/log-match.ts`. */
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runLogs(input: RunLogsInput): RunLogsResult {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const holder = { code: 0 };

  const done = (async () => {
    // Resolve the worktree → stack_id. detectWorktree throws if no
    // lich.yaml is found at/above cwd; surface that as "no stack found".
    let stackId: string;
    try {
      stackId = detectWorktree(cwd).stack_id;
    } catch {
      writeLine(out, "no stack found for this worktree");
      holder.code = 1;
      return;
    }

    const snapshot = await readSnapshot(stackId);
    if (snapshot === null) {
      writeLine(out, "no stack found for this worktree");
      holder.code = 1;
      return;
    }

    // Resolve which services to stream.
    const services = resolveServices(snapshot, input.service);
    if (services === null) {
      // Unknown service name; the user-facing message has been written.
      holder.code = 1;
      return;
    }

    // Prefix iff multiple services. Per-service filter mode → no prefix
    // (even though `services` has length 1, that's the same condition).
    const prefix = services.length > 1;

    // --- initial tail dump ---
    // Read each service in order. Track each file's byte offset so the
    // follow loop knows where to pick up.
    const offsets = new Map<string, number>();
    for (const svc of services) {
      const path = serviceLogPath(stackId, svc);
      const { content, size } = await safeReadAll(path);
      offsets.set(svc, size);
      if (content.length === 0) continue;

      const lines = tailLines(content, input.tail);
      for (const line of lines) {
        emitLine(out, prefix ? svc : null, line);
      }
    }

    if (!input.follow) return;

    // --- follow loop: poll each file for growth, emit appended lines ---
    // Each tick: for each service, stat the file. If size > offset, read
    // the new bytes from offset, split into complete lines, emit, and
    // carry any trailing partial line for the next tick.
    const pending = new Map<string, string>();
    for (const svc of services) pending.set(svc, "");

    while (true) {
      if (input.signal?.aborted) return;

      for (const svc of services) {
        if (input.signal?.aborted) return;

        const path = serviceLogPath(stackId, svc);
        let size: number | null = null;
        try {
          const st = await stat(path);
          size = st.size;
        } catch {
          // File doesn't exist yet (or transient error). Keep polling;
          // it may appear later when the service starts writing.
          continue;
        }

        const prev = offsets.get(svc) ?? 0;
        if (size <= prev) continue;

        const length = size - prev;
        const buf = Buffer.allocUnsafe(length);
        const handle = await open(path, "r");
        let bytesRead = 0;
        try {
          const r = await handle.read(buf, 0, length, prev);
          bytesRead = r.bytesRead;
        } finally {
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
        }
        offsets.set(svc, prev + bytesRead);
        if (bytesRead === 0) continue;

        const chunk = buf.slice(0, bytesRead).toString("utf8");
        const carry = pending.get(svc) ?? "";
        const combined = carry + chunk;

        // Split out complete lines (terminated by '\n') and carry any
        // trailing partial. Use a CRLF-tolerant split.
        const lastNewline = combined.lastIndexOf("\n");
        if (lastNewline < 0) {
          pending.set(svc, combined);
          continue;
        }
        const complete = combined.slice(0, lastNewline);
        pending.set(svc, combined.slice(lastNewline + 1));

        for (const line of complete.split(/\r?\n/)) {
          emitLine(out, prefix ? svc : null, line);
        }
      }

      await sleep(POLL_INTERVAL_MS, input.signal);
    }
  })().catch((err) => {
    // Any unexpected error: surface to `out` and mark non-zero.
    writeLine(out, `lich logs: ${(err as Error).message}`);
    holder.code = 1;
  });

  return {
    get exitCode() {
      return holder.code;
    },
    done,
  };

  /**
   * Pick the services to stream. With no filter → every service in the
   * snapshot. With a filter → just the named one. If the filter doesn't
   * match any known service, write a user-facing error line to `out` and
   * return null so the caller can mark exitCode=1.
   */
  function resolveServices(
    snapshot: StackSnapshot,
    filter: string | undefined,
  ): string[] | null {
    const allNames = snapshot.services.map((s) => s.name);
    if (filter === undefined) return allNames;
    if (allNames.includes(filter)) return [filter];

    const available = allNames.length > 0 ? allNames.join(", ") : "(none)";
    writeLine(
      out,
      `unknown service "${filter}"; available services: ${available}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read an entire file as utf-8 plus its size. Returns empty content with
 * size=0 if the file doesn't exist.
 */
async function safeReadAll(
  path: string,
): Promise<{ content: string; size: number }> {
  let size = 0;
  try {
    const st = await stat(path);
    size = st.size;
  } catch {
    return { content: "", size: 0 };
  }
  if (size === 0) return { content: "", size: 0 };

  const buf = Buffer.allocUnsafe(size);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return {
      content: buf.slice(0, bytesRead).toString("utf8"),
      size: bytesRead,
    };
  } finally {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Return the last `n` complete lines of `content`. A trailing partial
 * line (content not ending in `\n`) IS included as the final line — this
 * matches `tail`'s behavior and keeps us from dropping a "stuck" last
 * line that a service hasn't terminated yet.
 */
function tailLines(content: string, n: number): string[] {
  if (n <= 0) return [];
  // Strip a single trailing newline so we don't emit a blank final line.
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (trimmed.length === 0) return [];
  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= n) return lines;
  return lines.slice(lines.length - n);
}

/** Emit a single line with optional `[svc] ` prefix. */
function emitLine(
  out: NodeJS.WritableStream,
  prefix: string | null,
  line: string,
): void {
  if (prefix !== null) {
    out.write(`[${prefix}] ${line}\n`);
  } else {
    out.write(`${line}\n`);
  }
}

function writeLine(out: NodeJS.WritableStream, line: string): void {
  out.write(`${line}\n`);
}

/** Sleep that returns early if `signal` aborts. Mirrors log-match.ts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
