/**
 * JSON output mode: NDJSON event stream, one object per line.
 * Back-compat: extend event shapes additively; never rename existing fields.
 */

import type { FailureBlock } from "../failure/formatter.js";
import type {
  LifecycleEntryCompletion,
  LifecycleEntryStart,
} from "../lifecycle/executor.js";
import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";

export interface JsonOptions {
  /** Emit `elapsed_ms` on every `phase_end`. Summary carries elapsed_ms independently when SummaryBlock sets it. */
  showTiming?: boolean;
}

/** Build the `{ type: "failure", title, reason, log_tail, hint? }` event. Shared with quiet.ts so both modes emit identical bytes. */
export function buildFailureEvent(block: FailureBlock): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: "failure",
    title: block.title,
    reason: block.reason,
    log_tail: block.logTail,
  };
  if (block.hint !== undefined) event.hint = block.hint;
  return event;
}

export function createJsonOutput(
  stream: NodeJS.WritableStream,
  opts: JsonOptions = {},
): Output {
  const showTiming = opts.showTiming === true;
  const write = (obj: unknown): void => {
    stream.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    phase(name: string): PhaseHandle {
      const startedAt = Date.now();
      // Track current name so phase_step/phase_end carry the latest;
      // phase_begin keeps the initial name so consumers can stitch the
      // timeline via the phase_update chain.
      let currentName = name;
      write({ type: "phase_begin", name });
      return {
        step(line: string): void {
          write({ type: "phase_step", name: currentName, step: line });
        },
        update(newName: string): void {
          currentName = newName;
          write({ type: "phase_update", name: currentName });
        },
        end(status: "ok" | "fail" | "skip", message?: string): void {
          const event: Record<string, unknown> = {
            type: "phase_end",
            name: currentName,
            status,
          };
          if (message !== undefined) event.message = message;
          if (showTiming) event.elapsed_ms = Date.now() - startedAt;
          write(event);
        },
      };
    },

    info(line: string): void {
      write({ type: "info", message: line });
    },

    service(name: string, state: ServiceState, detail?: string): void {
      const event: Record<string, unknown> = { type: "service", name, state };
      if (detail !== undefined) event.detail = detail;
      write(event);
    },

    summary(summary: SummaryBlock): void {
      const event: Record<string, unknown> = {
        type: "summary",
        title: summary.title,
        lines: summary.lines,
      };
      if (summary.services !== undefined) event.services = summary.services;
      if (summary.urls !== undefined) event.urls = summary.urls;
      if (summary.next !== undefined) event.next = summary.next;
      if (summary.elapsedMs !== undefined) event.elapsed_ms = summary.elapsedMs;
      write(event);
    },

    error(err: ErrorBlock): void {
      const event: Record<string, unknown> = {
        type: "error",
        title: err.title,
        detail: err.detail,
      };
      if (err.hint !== undefined) event.hint = err.hint;
      write(event);
    },

    failure(block: FailureBlock): void {
      write(buildFailureEvent(block));
    },

    lifecycleEntryStart(start: LifecycleEntryStart): void {
      write({
        type: "lifecycle_entry_start",
        phase: start.phase,
        index: start.index,
        total: start.total,
        cmd: start.cmd,
      });
    },

    lifecycleEntryComplete(completion: LifecycleEntryCompletion): void {
      const event: Record<string, unknown> = {
        type: "lifecycle_entry_complete",
        phase: completion.phase,
        index: completion.index,
        total: completion.total,
        cmd: completion.cmd,
        exit_code: completion.exitCode,
        elapsed_ms: completion.elapsedMs,
        stderr_tail: completion.stderrTail,
      };
      if (completion.logPath !== undefined) {
        event.log_path = completion.logPath;
      }
      write(event);
    },

    async close(): Promise<void> {},
  };
}
