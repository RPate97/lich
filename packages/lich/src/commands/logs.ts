import { open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { logsDir, phaseLogPath, serviceLogPath } from "../state/directory.js";
import { readSnapshot, type StackSnapshot } from "../state/snapshot.js";
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { resolveStackId } from "../state/resolve-stack.js";
import type { LifecyclePhase } from "../lifecycle/executor.js";
import { parseConfig } from "../config/parse.js";
import { isSandboxStack } from "../sandbox/marker.js";
import { maybeRouteToSandbox } from "../sandbox/command-routing.js";

export interface RunLogsInput {
  /** Source filter: service names or phase names. If omitted, all sources. */
  sources?: string[];
  /** Follow mode (poll-tail). */
  follow: boolean;
  /** Default page size (default 100). Overridable via --count. */
  count: number;
  /** Cursor for "before" pagination: show `count` lines before this line number. */
  before?: number;
  /** Cursor for "after" pagination: show lines after this line number. */
  after?: number;
  /** Regex filter string. */
  grep?: string;
  /** Emit all lines with no pagination. */
  all: boolean;
  /** Machine-readable JSON output. */
  json: boolean;
  /** Stack ID or worktree name (`--worktree`); defaults to cwd-derived. */
  worktreeArg?: string;
  cwd?: string;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

export interface RunLogsResult {
  readonly exitCode: number;
  done: Promise<void>;
}

const POLL_INTERVAL_MS = 100;

const PHASE_NAMES = new Set<string>([
  "before_up",
  "after_up",
  "before_down",
  "after_down",
]);

export interface LogLine {
  n: number;
  source: string;
  text: string;
}

export interface LogPage {
  lines: LogLine[];
  cursor: { before: number; after: number };
  total_lines: number;
  has_more_before: boolean;
  has_more_after: boolean;
  new_since_after_cursor: number;
}

export function runLogs(input: RunLogsInput): RunLogsResult {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const holder = { code: 0 };

  const done = (async () => {
    let stackId: string;
    let snapshot: StackSnapshot | null;
    let worktree: Worktree | null = null;
    try {
      const resolved = await resolveStackId({
        cwd,
        ...(input.worktreeArg !== undefined && { worktreeArg: input.worktreeArg }),
      });
      stackId = resolved.stackId;
      snapshot = resolved.snapshot;
      try { worktree = detectWorktree(cwd); } catch { worktree = null; }
    } catch (err) {
      if (input.worktreeArg) {
        writeLine(out, (err as Error).message);
      } else {
        writeLine(out, "no stack found for this worktree");
      }
      holder.code = 1;
      return;
    }

    if (snapshot === null) {
      snapshot = await readSnapshot(stackId);
    }
    if (snapshot === null) {
      writeLine(out, "no stack found for this worktree");
      holder.code = 1;
      return;
    }

    if (isSandboxStack(snapshot)) {
      const wt = worktree ?? {
        name: snapshot.worktree_name,
        id: stackId,
        path: snapshot.worktree_path,
        stack_id: snapshot.stack_id,
      };
      const configPath = join(wt.path, "lich.yaml");
      const parsed = existsSync(configPath) ? await parseConfig(configPath) : null;
      const sandboxConfig = parsed?.ok ? parsed.config.runtime?.sandbox : undefined;
      const routed = await maybeRouteToSandbox({
        kind: "logs",
        snapshot,
        worktree: wt,
        lichYamlPath: configPath,
        argv: { sources: input.sources, follow: input.follow, tail: input.count },
        sandboxConfig,
      });
      if (routed !== null) {
        holder.code = routed.exitCode;
        return;
      }
    }

    const resolved = resolveSources(snapshot, input.sources, out);
    if (resolved === null) {
      holder.code = 1;
      return;
    }

    let grepRe: RegExp | null = null;
    if (input.grep) {
      try {
        grepRe = new RegExp(input.grep, "u");
      } catch {
        writeLine(out, `lich logs: invalid --grep pattern: ${input.grep}`);
        holder.code = 1;
        return;
      }
    }

    if (input.follow) {
      await runFollow(stackId, resolved, grepRe, input, out);
      return;
    }

    const merged = await readMerged(stackId, resolved);
    const filtered = grepRe
      ? merged.filter((l) => grepRe!.test(l.text))
      : merged;

    if (input.after !== undefined) {
      await runAfterCursor(filtered, input.after, out, input.json);
      return;
    }

    const count = input.count;
    const total = filtered.length;

    let page: LogLine[];
    let startN: number;
    let endN: number;

    if (input.before !== undefined) {
      const beforeIdx = input.before - 1;
      const start = Math.max(0, beforeIdx - count);
      page = filtered.slice(start, beforeIdx);
      startN = start + 1;
      endN = beforeIdx;
    } else if (input.all) {
      page = filtered;
      startN = 1;
      endN = total;
    } else {
      // default: last `count` lines
      const start = Math.max(0, total - count);
      page = filtered.slice(start);
      startN = start + 1;
      endN = total;
    }

    if (input.json) {
      const result: LogPage = {
        lines: page,
        cursor: {
          before: startN,
          after: endN,
        },
        total_lines: total,
        has_more_before: startN > 1,
        has_more_after: false,
        new_since_after_cursor: 0,
      };
      writeLine(out, JSON.stringify(result));
      return;
    }

    const prefix = resolved.length > 1;
    for (const line of page) {
      emitLine(out, prefix ? line.source : null, line.text);
    }

    if (!input.all && total > 0) {
      const hasMoreBefore = startN > 1;
      writeLine(out, "");
      writeLine(
        out,
        `Showing lines ${startN}–${endN} of ${total} (newest first).`,
      );
      if (hasMoreBefore) {
        writeLine(out, `Older: lich logs --before ${startN}`);
      }
      writeLine(out, `Newer: lich logs --after ${endN}`);
      if (input.grep) {
        writeLine(out, `Filter: --grep ${JSON.stringify(input.grep)}   Full: --all   Live: --follow`);
      } else {
        writeLine(out, `Full: --all   Live: --follow`);
      }
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
}

async function runAfterCursor(
  allLines: LogLine[],
  afterCursor: number,
  out: NodeJS.WritableStream,
  json: boolean,
): Promise<void> {
  const newLines = allLines.filter((l) => l.n > afterCursor);
  const total = allLines.length;
  const newCount = newLines.length;

  if (json) {
    const endN = total;
    const result: LogPage = {
      lines: newLines,
      cursor: {
        before: afterCursor + 1,
        after: endN,
      },
      total_lines: total,
      has_more_before: afterCursor > 0,
      has_more_after: false,
      new_since_after_cursor: newCount,
    };
    writeLine(out, JSON.stringify(result));
    return;
  }

  if (newCount === 0) {
    writeLine(out, `No new lines since cursor ${afterCursor}.`);
    return;
  }

  const prefix = new Set(newLines.map((l) => l.source)).size > 1;
  for (const line of newLines) {
    emitLine(out, prefix ? line.source : null, line.text);
  }
  writeLine(out, "");
  writeLine(out, `${newCount} new line${newCount === 1 ? "" : "s"} since cursor ${afterCursor}.`);
  writeLine(out, `Next: lich logs --after ${total}`);
}

async function runFollow(
  stackId: string,
  sources: Source[],
  grepRe: RegExp | null,
  input: RunLogsInput,
  out: NodeJS.WritableStream,
): Promise<void> {
  const offsets = new Map<string, number>();

  for (const src of sources) {
    const path = sourcePath(stackId, src);
    const { content, size } = await safeReadAll(path);
    offsets.set(src.name, size);
    if (content.length === 0) continue;

    const lines = tailLines(content, input.count);
    const prefix = sources.length > 1;
    for (const line of lines) {
      if (grepRe && !grepRe.test(line)) continue;
      emitLine(out, prefix ? src.name : null, line);
    }
  }

  const pending = new Map<string, string>();
  for (const src of sources) pending.set(src.name, "");

  while (true) {
    if (input.signal?.aborted) return;

    for (const src of sources) {
      if (input.signal?.aborted) return;

      const path = sourcePath(stackId, src);
      let size: number | null = null;
      try {
        const st = await stat(path);
        size = st.size;
      } catch {
        continue;
      }

      const prev = offsets.get(src.name) ?? 0;
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
      offsets.set(src.name, prev + bytesRead);
      if (bytesRead === 0) continue;

      const chunk = buf.slice(0, bytesRead).toString("utf8");
      const carry = pending.get(src.name) ?? "";
      const combined = carry + chunk;

      const lastNewline = combined.lastIndexOf("\n");
      if (lastNewline < 0) {
        pending.set(src.name, combined);
        continue;
      }
      const complete = combined.slice(0, lastNewline);
      pending.set(src.name, combined.slice(lastNewline + 1));

      const prefix = sources.length > 1;
      for (const line of complete.split(/\r?\n/)) {
        if (grepRe && !grepRe.test(line)) continue;
        emitLine(out, prefix ? src.name : null, line);
      }
    }

    await sleep(POLL_INTERVAL_MS, input.signal);
  }
}

interface Source {
  name: string;
  kind: "service" | "phase";
}

function sourcePath(stackId: string, src: Source): string {
  if (src.kind === "phase") {
    return phaseLogPath(stackId, src.name as LifecyclePhase);
  }
  return serviceLogPath(stackId, src.name);
}

/** Build the merged chronological line list from all sources. */
async function readMerged(stackId: string, sources: Source[]): Promise<LogLine[]> {
  const allLines: LogLine[] = [];

  for (const src of sources) {
    const path = sourcePath(stackId, src);
    const { content } = await safeReadAll(path);
    if (content.length === 0) continue;

    const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
    const lines = trimmed.split(/\r?\n/);
    for (const text of lines) {
      allLines.push({ n: 0, source: src.name, text });
    }
  }

  // Assign stable line numbers (1-based).
  for (let i = 0; i < allLines.length; i++) {
    allLines[i]!.n = i + 1;
  }

  return allLines;
}

function resolveSources(
  snapshot: StackSnapshot,
  filter: string[] | undefined,
  out: NodeJS.WritableStream,
): Source[] | null {
  const serviceNames = snapshot.services.map((s) => s.name);
  const phaseNames = [...PHASE_NAMES];
  const allSourceNames = [...serviceNames, ...phaseNames];

  if (!filter || filter.length === 0) {
    const sources: Source[] = serviceNames.map((n) => ({ name: n, kind: "service" as const }));
    return sources;
  }

  const result: Source[] = [];
  for (const name of filter) {
    if (serviceNames.includes(name)) {
      result.push({ name, kind: "service" });
    } else if (PHASE_NAMES.has(name)) {
      result.push({ name, kind: "phase" });
    } else {
      const available = allSourceNames.length > 0 ? allSourceNames.join(", ") : "(none)";
      writeLine(out, `unknown source "${name}"; available: ${available}`);
      return null;
    }
  }

  return result;
}

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
