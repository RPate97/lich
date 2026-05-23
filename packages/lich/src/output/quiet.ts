/**
 * Quiet output mode.
 *
 * Suppresses phase begin/step/info/service events. Summary and error
 * blocks still emit (rendered with the same pretty-but-no-spinner
 * formatting as non-TTY pretty mode) so CI logs and scripts get a
 * machine-friendly final block.
 */

import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";
import { renderError, renderSummary } from "./pretty.js";

export function createQuietOutput(stream: NodeJS.WritableStream): Output {
  // A no-op phase handle; nothing renders until summary/error.
  const noopPhase: PhaseHandle = {
    step(_line: string): void {
      /* intentionally suppressed */
    },
    end(_status: "ok" | "fail" | "skip", _message?: string): void {
      /* intentionally suppressed */
    },
  };

  return {
    phase(_name: string): PhaseHandle {
      return noopPhase;
    },
    info(_line: string): void {
      /* intentionally suppressed */
    },
    service(_name: string, _state: ServiceState, _detail?: string): void {
      /* intentionally suppressed */
    },
    summary(summary: SummaryBlock): void {
      stream.write(renderSummary(summary, /* color */ false));
    },
    error(err: ErrorBlock): void {
      stream.write(renderError(err, /* color */ false));
    },
    async close(): Promise<void> {
      // Nothing to flush.
    },
  };
}
