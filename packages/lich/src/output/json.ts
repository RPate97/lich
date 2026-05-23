/**
 * JSON output mode: NDJSON event stream.
 *
 * One JSON object per line, terminated with `\n`. No spinners, no ANSI.
 * Event shapes are documented in src/output/index.ts.
 */

import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";

export function createJsonOutput(stream: NodeJS.WritableStream): Output {
  const write = (obj: unknown): void => {
    stream.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    phase(name: string): PhaseHandle {
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
