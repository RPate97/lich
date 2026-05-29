/**
 * Quiet output mode. Suppresses phase/info/service events; summary and
 * error still emit with no-color pretty formatting. Per-service failures
 * emit an NDJSON line on `errStream` (stderr) so quiet users still see them.
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
import { buildFailureEvent } from "./json.js";
import { renderError, renderSummary } from "./pretty.js";

export interface QuietOptions {
  /** Stream for the per-service failure NDJSON line. Defaults to process.stderr. */
  errStream?: NodeJS.WritableStream;
}

export function createQuietOutput(
  stream: NodeJS.WritableStream,
  opts: QuietOptions = {},
): Output {
  const errStream = opts.errStream ?? process.stderr;

  const noopPhase: PhaseHandle = {
    step(_line: string): void {
      /* suppressed */
    },
    update(_name: string): void {
      /* suppressed */
    },
    end(_status: "ok" | "fail" | "skip", _message?: string): void {
      /* suppressed */
    },
  };

  return {
    phase(_name: string): PhaseHandle {
      return noopPhase;
    },
    info(_line: string): void {
      /* suppressed */
    },
    service(_name: string, _state: ServiceState, _detail?: string): void {
      /* suppressed */
    },
    summary(summary: SummaryBlock): void {
      stream.write(renderSummary(summary, false));
    },
    error(err: ErrorBlock): void {
      stream.write(renderError(err, false));
    },
    failure(block: FailureBlock): void {
      errStream.write(`${JSON.stringify(buildFailureEvent(block))}\n`);
    },
    lifecycleEntryStart(_start: LifecycleEntryStart): void {
      /* suppressed — pick json mode for structured per-entry events */
    },
    lifecycleEntryComplete(_completion: LifecycleEntryCompletion): void {
      /* suppressed */
    },
    async close(): Promise<void> {},
  };
}
