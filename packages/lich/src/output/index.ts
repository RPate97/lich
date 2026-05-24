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

import type { FailureBlock } from "../failure/formatter.js";
import { createJsonOutput } from "./json.js";
import { createPrettyOutput } from "./pretty.js";
import { createQuietOutput } from "./quiet.js";

export type OutputMode = "pretty" | "json" | "quiet";

// Re-export FailureBlock so callers that already import from "./output/index.js"
// can reach the type without a second import path. The failure renderer and
// state-snapshot persistence are both downstream of the formatter that owns
// this type (see `src/failure/formatter.ts`).
export type { FailureBlock } from "../failure/formatter.js";

export type ServiceState =
  | "starting"
  | "healthy"
  | "initializing"
  | "ready"
  | "stopping"
  | "failed";

/**
 * One entry per service in a summary block. Carries per-service final state
 * plus optionally the ports allocated to it. The structured shape lets the
 * pretty renderer print a tidy table (`api    ready    1 port (9000)`) and
 * lets the json renderer surface the same data for downstream tools.
 */
export interface SummaryService {
  /** Service name as declared in `services:` / `owned:`. */
  name: string;
  /** Final state at the time the summary was emitted. */
  state: ServiceState;
  /**
   * Optional map of allocated ports keyed by port name. e.g.
   * `{ default: 9000 }` for a single-port owned service or
   * `{ api: 9001, studio: 9002 }` for a multi-port one.
   */
  ports?: Record<string, number>;
}

/**
 * One entry per service URL in a summary. Plan 1 surfaces raw
 * `http://localhost:<port>` URLs (Plan 5 will introduce friendly
 * `<service>.<worktree>.lich.localhost:<proxy-port>` URLs alongside).
 */
export interface SummaryUrl {
  /** Service name. */
  service: string;
  /** Reachable URL the user can hit (raw `http://localhost:<port>`). */
  url: string;
}

/**
 * A bottom-of-the-summary hint line — `lich logs    follow stack logs`.
 * Renders as a two-column block.
 */
export interface SummaryHint {
  /** The command itself, e.g. `lich logs`. */
  cmd: string;
  /** One-line description, e.g. `follow stack logs`. */
  description: string;
}

export interface SummaryBlock {
  /** e.g. "stack up" or "stack down". */
  title: string;
  /**
   * Optional wall-clock elapsed time in milliseconds since the run started.
   * Pretty mode renders this next to the title (`stack up — 12.4s`); json
   * mode surfaces it as `elapsed_ms`.
   */
  elapsedMs?: number;
  /** Bullet lines under the title. */
  lines: string[];
  /** Optional list of service final states (+ optional allocated ports). */
  services?: SummaryService[];
  /** Optional list of reachable URLs surfaced to the user. */
  urls?: SummaryUrl[];
  /** Optional list of "what now?" hint lines. */
  next?: SummaryHint[];
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
  /**
   * Per-service failure block (Plan 4). Always emitted, even in quiet.
   *
   * Contrast with {@link Output.error} which is for non-service failures
   * (yaml parse errors, missing files): `failure` carries log context for a
   * specific service. Pretty mode renders a red banner + reason + indented
   * log tail + cyan hint; json mode emits one `{ type: "failure", ... }`
   * NDJSON line; quiet mode emits the same NDJSON line on stderr so even
   * quiet users see per-service failures.
   *
   * The block is produced by `formatFailure` (`src/failure/formatter.ts`) —
   * renderers here are intentionally dumb: take the block, print it.
   */
  failure(block: FailureBlock): void;
  /** Flush any pending I/O (e.g. wait for spinners to clear). */
  close(): Promise<void>;
}

export interface CreateOutputOptions {
  mode: OutputMode;
  /** Defaults to process.stdout. Tests pass a captured stream. */
  stream?: NodeJS.WritableStream;
  /**
   * Stream used by quiet mode for the `failure` block (Plan 4). Defaults to
   * `process.stderr`. Other modes ignore this — pretty/json write the
   * failure block to the main `stream` like every other event. Tests pass a
   * captured stream to assert on quiet's NDJSON failure output without
   * polluting actual stderr.
   *
   * Why a separate stream just for quiet's failure path: the spec mandates
   * that even quiet users see per-service failures, and the natural place
   * for that signal in a CI / scripted context is stderr (so stdout stays
   * clean for the summary block the user is parsing). The other emitters
   * stay single-streamed because their failure output is already part of
   * the same human/json stream consumers are reading.
   */
  errStream?: NodeJS.WritableStream;
  /**
   * Render per-phase elapsed time on phase-end (`✓ phase — 1.2s`) and the
   * top-level elapsed in summaries. Defaults to `false` so unit tests with
   * exact-match assertions stay deterministic; production callers
   * (`commands/up.ts`) opt in by passing `true`.
   *
   * In json mode, this additionally emits an `elapsed_ms` field on every
   * `phase_end` event when set.
   */
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
      // Exhaustive check; runtime guard for callers that bypass types.
      const exhaustive: never = opts.mode;
      throw new Error(`Unknown output mode: ${String(exhaustive)}`);
    }
  }
}
