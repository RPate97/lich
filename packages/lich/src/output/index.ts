/**
 * Phased CLI output framework.
 *
 * Every lich command consumes this module to render progress, service
 * status, summaries, and errors. Three modes are supported:
 *
 *   - `pretty` (default for TTY): ANSI-colored output with optional
 *     spinner animation. Falls back to plain lines on non-TTY streams.
 *   - `json`: NDJSON event stream. One JSON object per line. Suitable
 *     for machine consumption (lich:instrument skill, meta-harness).
 *   - `quiet`: progress suppressed; summary + error still emit.
 *
 * Callers create one Output via `createOutput({ mode })`, drive it with
 * phases / steps / service updates, then finish with `summary()` or
 * `error()` and `await close()` to flush any animation state.
 */

import { createJsonOutput } from "./json.js";
import { createPrettyOutput } from "./pretty.js";
import { createQuietOutput } from "./quiet.js";

export type OutputMode = "pretty" | "json" | "quiet";

export type ServiceState =
  | "starting"
  | "healthy"
  | "initializing"
  | "ready"
  | "stopping"
  | "failed";

export interface SummaryBlock {
  /** e.g. "stack up" or "stack down". */
  title: string;
  /** Bullet lines under the title. */
  lines: string[];
  /** Optional list of service final states. */
  services?: { name: string; state: ServiceState }[];
}

export interface ErrorBlock {
  /** e.g. "failed to start api". */
  title: string;
  /** Multi-line detail (preserved as-is). */
  detail: string;
  /** Optional hint about what to do next. */
  hint?: string;
}

export interface PhaseHandle {
  /**
   * Sub-step within the phase (e.g. "allocating port for api").
   * Pretty: appears as an indented line under the spinner.
   * JSON: emits a `phase_step` event.
   * Quiet: ignored.
   */
  step(line: string): void;
  /** Mark the phase complete. */
  end(status: "ok" | "fail" | "skip", message?: string): void;
}

export interface Output {
  /** Begin a named phase. Returns a handle; ALWAYS .end(...) it. */
  phase(name: string): PhaseHandle;
  /** One-off informational line outside phases. Ignored in quiet. */
  info(line: string): void;
  /** Per-service status update. Surfaces in pretty + json; ignored in quiet. */
  service(name: string, state: ServiceState, detail?: string): void;
  /** Final summary block. Always emitted (even in quiet). */
  summary(summary: SummaryBlock): void;
  /** Error block. Always emitted. Process should exit non-zero after. */
  error(err: ErrorBlock): void;
  /** Flush any pending I/O (e.g. wait for spinners to clear). */
  close(): Promise<void>;
}

export interface CreateOutputOptions {
  mode: OutputMode;
  /** Defaults to process.stdout. Tests pass a captured stream. */
  stream?: NodeJS.WritableStream;
}

export function createOutput(opts: CreateOutputOptions): Output {
  const stream = opts.stream ?? process.stdout;
  switch (opts.mode) {
    case "json":
      return createJsonOutput(stream);
    case "quiet":
      return createQuietOutput(stream);
    case "pretty":
      return createPrettyOutput(stream);
    default: {
      // Exhaustive check; runtime guard for callers that bypass types.
      const exhaustive: never = opts.mode;
      throw new Error(`Unknown output mode: ${String(exhaustive)}`);
    }
  }
}
