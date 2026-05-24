/**
 * JSON output mode: NDJSON event stream.
 *
 * One JSON object per line, terminated with `\n`. No spinners, no ANSI.
 * Event shapes are documented in src/output/index.ts.
 *
 * Back-compat: when extending event shapes (e.g. LEV-301 added `urls`,
 * `next`, `elapsed_ms`, and per-service `ports` to `summary`), prefer
 * additive fields over renames. Downstream consumers (lich:instrument
 * skill, agent harnesses) may parse historical fields strictly; new
 * optional fields are safe.
 */

import type { FailureBlock } from "../failure/formatter.js";
import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";

export interface JsonOptions {
  /**
   * When true, emit `elapsed_ms` on every `phase_end` event. The summary
   * event always carries `elapsed_ms` when `SummaryBlock.elapsedMs` is
   * set, regardless of this flag (since the caller controls that field
   * explicitly). Defaults to false so existing JSON consumers / tests
   * with exact-shape assertions stay stable; production CLI opts in.
   */
  showTiming?: boolean;
}

/**
 * Build the NDJSON event object for a per-service failure (Plan 4).
 *
 * Shape: `{ type: "failure", title, reason, log_tail, hint? }`. The `hint`
 * field is omitted entirely when undefined so consumers using `in` /
 * `Object.hasOwn` checks don't see a phantom key.
 *
 * Exported so `quiet.ts` can emit the same object to its stderr stream
 * without re-implementing the field shape — both renderers MUST agree byte
 * for byte so downstream parsers don't need to branch on output mode.
 */
export function buildFailureEvent(block: FailureBlock): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: "failure",
    title: block.title,
    reason: block.reason,
    // `log_tail` (snake_case) matches the field name used by `state.json`'s
    // `failure_log_tail`, the JSON consumers' existing naming convention,
    // and the spec's `{ "type": "failure", "title", "reason", "log_tail",
    // "hint" }` shape verbatim.
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
      write({ type: "phase_begin", name });
      return {
        step(line: string): void {
          write({ type: "phase_step", name, step: line });
        },
        end(status: "ok" | "fail" | "skip", message?: string): void {
          const event: Record<string, unknown> = {
            type: "phase_end",
            name,
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
      // Per-service failure as a single NDJSON line, same shape as quiet
      // mode's stderr emission so downstream consumers (lich:instrument,
      // dashboards) parse one schema regardless of the user's chosen mode.
      write(buildFailureEvent(block));
    },

    async close(): Promise<void> {
      // Nothing to flush; we write synchronously line-by-line.
    },
  };
}
