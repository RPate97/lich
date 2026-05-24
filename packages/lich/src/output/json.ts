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

    async close(): Promise<void> {
      // Nothing to flush; we write synchronously line-by-line.
    },
  };
}
