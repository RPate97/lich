/**
 * Quiet output mode.
 *
 * Suppresses phase begin/step/info/service events. Summary and error
 * blocks still emit (rendered with the same pretty-but-no-spinner
 * formatting as non-TTY pretty mode) so CI logs and scripts get a
 * machine-friendly final block.
 *
 * Per-service failure blocks (Plan 4) are different: even quiet users
 * MUST see them, so they emit a single NDJSON line to stderr (the
 * `errStream` option, defaulting to `process.stderr`). This keeps the
 * primary stream clean for the summary that scripts parse, while still
 * surfacing the failure to the operator who's tailing logs.
 */

import type { FailureBlock } from "../failure/formatter.js";
import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";
import { buildFailureEvent } from "./json.js";
import { renderError, renderSummary } from "./pretty.js";

export interface QuietOptions {
  /**
   * Stream the per-service failure NDJSON line is written to. Defaults to
   * `process.stderr` when omitted. Tests pass a captured stream to assert
   * on the failure payload without touching real stderr.
   */
  errStream?: NodeJS.WritableStream;
}

export function createQuietOutput(
  stream: NodeJS.WritableStream,
  opts: QuietOptions = {},
): Output {
  const errStream = opts.errStream ?? process.stderr;

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
    failure(block: FailureBlock): void {
      // Single NDJSON line on stderr — same shape as json mode (via the
      // shared `buildFailureEvent`) so downstream parsers consume one
      // schema regardless of which mode the operator chose.
      errStream.write(`${JSON.stringify(buildFailureEvent(block))}\n`);
    },
    async close(): Promise<void> {
      // Nothing to flush.
    },
  };
}
