/**
 * Phased CLI output framework. Three modes: `pretty` (ANSI + spinner on
 * TTY, plain lines otherwise), `json` (NDJSON, one event per line), and
 * `quiet` (suppresses progress; summary + error still emit).
 */

import type { FailureBlock } from "../failure/formatter.js";
import type {
  LifecycleEntryCompletion,
  LifecycleEntryStart,
} from "../lifecycle/executor.js";
import { createJsonOutput } from "./json.js";
import { createPrettyOutput } from "./pretty.js";
import { createQuietOutput } from "./quiet.js";

export type OutputMode = "pretty" | "json" | "quiet";

// Re-export so callers don't need a second import path.
export type { FailureBlock } from "../failure/formatter.js";

export type ServiceState =
  | "starting"
  | "healthy"
  | "initializing"
  | "ready"
  | "stopping"
  | "failed";

/** One entry per service in a summary block — final state + optional allocated ports. */
export interface SummaryService {
  name: string;
  state: ServiceState;
  /** Map of allocated ports keyed by port name, e.g. `{ default: 9000 }`. */
  ports?: Record<string, number>;
}

/** Reachable URL surfaced in a summary. */
export interface SummaryUrl {
  service: string;
  url: string;
}

/** Bottom-of-summary hint line, e.g. `lich logs    follow stack logs`. */
export interface SummaryHint {
  cmd: string;
  description: string;
}

export interface SummaryBlock {
  title: string;
  /** Wall-clock elapsed ms; pretty renders next to the title, json surfaces as `elapsed_ms`. */
  elapsedMs?: number;
  lines: string[];
  services?: SummaryService[];
  urls?: SummaryUrl[];
  next?: SummaryHint[];
}

export interface ErrorBlock {
  title: string;
  /** Multi-line detail, preserved as-is. */
  detail: string;
  hint?: string;
}

export interface PhaseHandle {
  /** Sub-step within the phase. Pretty indents under the spinner; json emits `phase_step`; quiet ignored. */
  step(line: string): void;
  /**
   * Replace the phase's displayed name (e.g. per-service progress in `lich down`).
   * Pretty TTY: spinner repaints on next tick. Pretty non-TTY: emits a fresh `▶ <name>` line.
   * JSON: emits `phase_update`. Quiet: ignored.
   * Original startedAt is preserved so `.end()` elapsed covers the full span.
   */
  update(name: string): void;
  end(status: "ok" | "fail" | "skip", message?: string): void;
}

export interface Output {
  /** Begin a named phase. ALWAYS .end(...) the handle. */
  phase(name: string): PhaseHandle;
  /** One-off line outside phases. Ignored in quiet. */
  info(line: string): void;
  /** Per-service status update. Ignored in quiet. */
  service(name: string, state: ServiceState, detail?: string): void;
  /** Final summary. Always emitted. */
  summary(summary: SummaryBlock): void;
  /** Error block. Always emitted. */
  error(err: ErrorBlock): void;
  /**
   * Per-service failure. Always emitted; quiet writes the NDJSON line to
   * `errStream` (stderr) so even quiet users see per-service failures.
   * Block is produced by `formatFailure`; renderers just print it.
   */
  failure(block: FailureBlock): void;
  /** Per-hook lifecycle-entry start. Pretty prints `▶ <phase> (i/N): <cmd>`; json emits `lifecycle_entry_start`; quiet silent. */
  lifecycleEntryStart(start: LifecycleEntryStart): void;
  /**
   * Per-hook lifecycle-entry completion. Pretty prints `✓ <phase> (i/N) — <elapsed>` (or `✗`)
   * plus an inline stderr surface when the tail is non-empty. JSON emits `lifecycle_entry_complete`.
   * Quiet is silent.
   */
  lifecycleEntryComplete(completion: LifecycleEntryCompletion): void;
  /** Flush any pending I/O (e.g. wait for spinners to clear). */
  close(): Promise<void>;
}

export interface CreateOutputOptions {
  mode: OutputMode;
  /** Defaults to process.stdout. */
  stream?: NodeJS.WritableStream;
  /** Stream used by quiet mode for failure blocks. Defaults to process.stderr; ignored by other modes. */
  errStream?: NodeJS.WritableStream;
  /** Render per-phase elapsed time and the top-level elapsed in summaries. Defaults to false. */
  showTiming?: boolean;
}

export function createOutput(opts: CreateOutputOptions): Output {
  const stream = opts.stream ?? process.stdout;
  const errStream = opts.errStream ?? process.stderr;
  const showTiming = opts.showTiming === true;
  switch (opts.mode) {
    case "json":
      return createJsonOutput(stream, { showTiming });
    case "quiet":
      return createQuietOutput(stream, { errStream });
    case "pretty":
      return createPrettyOutput(stream, { showTiming });
    default: {
      // Exhaustive check; runtime guard for callers bypassing types.
      const exhaustive: never = opts.mode;
      throw new Error(`Unknown output mode: ${String(exhaustive)}`);
    }
  }
}
