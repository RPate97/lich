/**
 * `lich logs [service]` — read per-service log files from the state directory.
 * Without a service arg, aggregates all services with `[svc]` prefixes.
 */

import { open, stat } from "node:fs/promises";

import { serviceLogPath } from "../state/directory.js";
import { readSnapshot, type StackSnapshot } from "../state/snapshot.js";
import { detectWorktree } from "../worktree/detect.js";

export interface RunLogsInput {
  /** Optional service filter. If omitted, all services are aggregated. */
  service?: string;
  /** Follow mode (poll-tail). */
  follow: boolean;
  /** Initial tail size in lines per service. */
  tail: number;
  cwd?: string;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

export interface RunLogsResult {
  readonly exitCode: number;
  /** Resolves after the initial dump (non-follow) or on abort (follow). */
  done: Promise<void>;
}

const POLL_INTERVAL_MS = 100;

export function runLogs(input: RunLogsInput): RunLogsResult {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const holder = { code: 0 };

  const done = (async () => {
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

    const services = resolveServices(snapshot, input.service);
    if (services === null) {
      holder.code = 1;
      return;
    }

    const prefix = services.length > 1;

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
          // file may appear later when the service starts writing
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

        // Split on complete lines; carry trailing partial to next tick.
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
    writeLine(out, `lich logs: ${(err as Error).message}`);
    holder.code = 1;
  });

  return {
    get exitCode() {
      return holder.code;
    },
    done,
  };

  /** Returns the service names to stream, or null if `filter` is unknown (writes an error). */
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

/** Read an entire file as utf-8 plus its size. Returns empty/0 if absent. */
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
 * Last `n` lines of `content`. Includes a trailing partial line (matches
 * `tail`'s behavior, so a service's unterminated last line isn't dropped).
 */
function tailLines(content: string, n: number): string[] {
  if (n <= 0) return [];
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (trimmed.length === 0) return [];
  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= n) return lines;
  return lines.slice(lines.length - n);
}

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

/** Sleep that returns early if `signal` aborts. */
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
