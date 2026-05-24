/**
 * Failure formatter — pure function that turns a typed failure event into the
 * rendered "failure block" the CLI prints when an owned service can't be
 * brought up (Plan 4 Task 9).
 *
 * The formatter sits between the runtime layer (where the failure was
 * detected — `ProcessExitWatcher`, `withTimeout`, `watchFailWhen`,
 * `runCapture`) and the output layer (Plan 4 Task 11, where the block is
 * actually written to stdout / stderr / state.json). Centralizing the
 * format-building here means:
 *
 *   1. Every callsite that detects a failure produces the SAME block shape
 *      regardless of how the failure was detected, so the renderer doesn't
 *      need to branch on failure kind.
 *   2. The block is purely data (`{ title, reason, logTail, hint? }`), which
 *      lets the same formatter feed pretty rendering, ndjson emission, and
 *      `state.json` persistence (`failure_reason` + `failure_log_tail`) from
 *      one source of truth.
 *   3. Everything here is a pure function — no I/O, no side effects, no
 *      dependence on globals — so it's trivially testable with table-driven
 *      cases and safe to call from anywhere in the orchestrator.
 *
 * ### What this file deliberately does NOT do
 *
 * - **No rendering / printing.** The block is data. `output/pretty.ts` adds
 *   ANSI color; `output/json.ts` emits ndjson; `output/quiet.ts` decides
 *   whether to suppress. The formatter knows none of this.
 * - **No service-name interpretation.** The caller passes `service` as a
 *   string; we embed it in the title verbatim. We don't validate it's a real
 *   service, don't look it up, don't infer anything from it.
 * - **No "policy" decisions** beyond the small set of well-known hints
 *   documented in `inferHint` below. Lich is not a debugger; we point at
 *   the obvious next step and stop.
 * - **No log-buffer fetching.** The caller passes the buffer string (the
 *   moment-of-failure snapshot of `LogTail.buffer`); the formatter only
 *   trims and splits. This keeps the formatter independent of `LogTail`'s
 *   lifecycle.
 *
 * ### Hint set (full enumeration — keep this list in sync with `inferHint`)
 *
 * - `fail_when` matched a line containing `EADDRINUSE` →
 *     "run `lich stacks` to find what's using the port"
 * - `fail_when` matched a line containing `Cannot find module` →
 *     "run `bun install` (or your package manager equivalent) in the service's directory"
 * - `kind: 'timeout'` →
 *     "increase ready_when.timeout or check the service is actually responding"
 * - `kind: 'capture_miss'` →
 *     "verify the regex matches the line the service actually printed; check `lich logs <service>` for the full log"
 *
 * Hints are best-effort. Adding cleverness for other patterns is an
 * open-ended rabbit hole — most failures are best understood by the user
 * reading the log tail and the reason string. Only add a new hint here if
 * the pattern is genuinely well-known AND the recommended next step is
 * obvious to lich (not user- or codebase-specific).
 */

import {
  formatProcessExitFailure,
  type ProcessExitFailure,
} from "./process-exit.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to {@link formatFailure} — a discriminated union covering every kind
 * of per-service failure Plan 4 surfaces.
 *
 * Every variant carries the `service` name so the title can name what
 * failed; the remaining fields are kind-specific. The kinds mirror the
 * detector types so a callsite that already has e.g. a `ProcessExitFailure`
 * just hands it over without restating the shape.
 *
 * The `logBuffer` field is OPTIONAL on every variant. When present, it's
 * the moment-of-failure snapshot of `LogTail.buffer` (or an empty string
 * if the LogTail wasn't started or the buffer was empty). The formatter
 * trims it down to the last 20 lines for embedding in the block; if absent
 * or empty, `logTail` is the empty array and the renderer skips the log
 * section.
 */
export type FailureInput =
  | {
      /** Owned service exited unexpectedly (non-zero code or signal). */
      kind: "exit";
      /** Service name (as it appears in `lich.yaml`). */
      service: string;
      /** The detector's output — typically from `ProcessExitWatcher.wait()`. */
      exit: ProcessExitFailure;
      /** Optional log buffer snapshot (`LogTail.buffer` at failure time). */
      logBuffer?: string;
    }
  | {
      /** `ready_when` evaluator did not satisfy within its deadline. */
      kind: "timeout";
      /** Service name. */
      service: string;
      /** The deadline that elapsed, in milliseconds. */
      ms: number;
      /**
       * Optional label naming which evaluator timed out (e.g. `"http_get"`).
       * Forwarded from {@link ReadyTimeoutError.phase}; omitted when the
       * detector couldn't disambiguate.
       */
      phase?: string;
      /** Optional log buffer snapshot. */
      logBuffer?: string;
    }
  | {
      /** A line in the service's log matched `fail_when.log_match`. */
      kind: "fail_when";
      /** Service name. */
      service: string;
      /**
       * The complete line that triggered the match (newline already stripped
       * by `LogTail`). Forwarded from {@link FailWhenMatchedError.matchedLine}.
       * The formatter quotes this in the reason so users see exactly which
       * log line tripped the sentinel.
       */
      matchedLine: string;
      /** Optional log buffer snapshot. */
      logBuffer?: string;
    }
  | {
      /**
       * A `ready_when.capture` regex compiled but found no match in the
       * service's log buffer at the moment ready fired.
       */
      kind: "capture_miss";
      /** Service name. */
      service: string;
      /** The capture key whose regex didn't match. */
      captureKey: string;
      /** Optional log buffer snapshot. */
      logBuffer?: string;
    };

/**
 * Renderer-agnostic representation of a single per-service failure.
 *
 * Every field is plain data — strings or arrays of strings — so the same
 * block flows unchanged into the pretty renderer (which adds ANSI), the
 * ndjson renderer (which serializes as-is), and the state.json snapshot
 * (which persists `reason` as `failure_reason` and `logTail` as
 * `failure_log_tail`).
 *
 * The renderer is responsible for visual presentation (color, indent,
 * trailing newlines); the formatter is responsible for content. The two
 * concerns deliberately don't overlap.
 */
export interface FailureBlock {
  /**
   * One-line headline. Conventionally `"service \"<name>\" <verb>"` —
   * examples: `"service \"api\" failed"`, `"service \"api\" did not become
   * ready in 30s"`, `"service \"api\" matched fail_when pattern"`. The
   * service name is double-quoted so it stands out from surrounding prose
   * in plain-text terminals.
   */
  title: string;
  /**
   * Free-form sentence describing what specifically happened. Examples:
   * `"exited with code 1 during startup"` (from `formatProcessExitFailure`),
   * `"matched fail_when line: \"EADDRINUSE somewhere\""`, `"capture key
   * \"url\" did not match any line in the service log"`. This is the field
   * persisted as `failure_reason` in `state.json`.
   */
  reason: string;
  /**
   * The last N (typically 20) log lines from the service at the moment of
   * failure, newline-stripped, oldest-first. Empty array when no log buffer
   * was provided OR when the buffer was empty. This is the field persisted
   * as `failure_log_tail` in `state.json`.
   *
   * The trim-to-20 happens here so every renderer agrees on the same tail
   * length without coordinating, and so `state.json` doesn't accidentally
   * carry megabytes of log content per failed service.
   */
  logTail: string[];
  /**
   * Optional best-effort next-step hint. Present when {@link inferHint}
   * recognizes a well-known pattern in the input; omitted otherwise so
   * renderers can skip the hint section cleanly. See the file-level comment
   * for the full enumeration of recognized patterns.
   */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of log lines included in `FailureBlock.logTail`. Chosen to
 * match the spec's "last 20 lines inline" guidance — enough context to
 * understand most failures without burying the title/reason on long-running
 * services. The `state.json` persistence layer relies on this cap to keep
 * snapshot files bounded.
 */
const LOG_TAIL_LINES = 20;

// ---------------------------------------------------------------------------
// formatFailure
// ---------------------------------------------------------------------------

/**
 * Turn a {@link FailureInput} into the rendered {@link FailureBlock}.
 *
 * Pure function — no I/O, no globals, deterministic for any given input.
 * Safe to call from anywhere in the orchestrator (including inside
 * `Promise.race` losers or cleanup handlers) and trivial to unit-test
 * exhaustively.
 *
 * The discriminated union over `input.kind` means adding a new failure
 * shape (a hypothetical `kind: 'health_check_failed'` in a future plan)
 * requires extending the switch here — TypeScript's exhaustiveness check
 * (`assertNever(input)`) catches the missing case at compile time.
 */
export function formatFailure(input: FailureInput): FailureBlock {
  // Extract the log tail once — every kind uses the same buffer-to-tail
  // logic, so doing it here keeps the per-kind branches focused on
  // building the title + reason + hint.
  const logTail = extractLogTail(input.logBuffer);

  switch (input.kind) {
    case "exit": {
      // Reuse `formatProcessExitFailure` so the wording stays consistent
      // with any other call site that surfaces a raw `ProcessExitFailure`
      // (e.g. a future low-level debug log).
      const reason = formatProcessExitFailure(input.exit);
      const block: FailureBlock = {
        title: `service "${input.service}" failed`,
        reason,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "timeout": {
      // Render the deadline in a human-friendly unit if possible (s for
      // whole-second deadlines; ms otherwise). The title and reason both
      // mention the duration so a user skimming output sees it twice — once
      // in the headline, once in the explanation.
      const human = renderDurationMs(input.ms);
      const phaseSuffix =
        input.phase !== undefined ? ` (${input.phase})` : "";
      const block: FailureBlock = {
        title: `service "${input.service}" did not become ready in ${human}`,
        reason: `ready_when did not satisfy within ${human}${phaseSuffix}`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "fail_when": {
      // Quote the matched line so the user sees exactly what tripped the
      // sentinel. Escape only the bare minimum (the surrounding quote
      // character) — over-escaping makes the line harder to read in the
      // terminal. If the line contained `"`, replacing it with `\"` keeps
      // the quoting unambiguous without obscuring the rest of the line.
      const safeLine = input.matchedLine.replace(/"/g, '\\"');
      const block: FailureBlock = {
        title: `service "${input.service}" matched fail_when pattern`,
        reason: `fail_when matched log line: "${safeLine}"`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "capture_miss": {
      const block: FailureBlock = {
        title: `service "${input.service}" capture "${input.captureKey}" not found`,
        reason: `ready_when.capture key "${input.captureKey}" did not match any line in the service log`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    default: {
      // Exhaustiveness check — TypeScript flags this branch at compile
      // time if a new `kind` variant is added to `FailureInput` without
      // a matching `case` above. Throwing at runtime is a belt-and-braces
      // guard in case a JS caller (or a future type-loosening) gets past
      // the compiler.
      return assertNever(input);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Trim a raw log buffer (anything from `LogTail.buffer`) down to the last
 * {@link LOG_TAIL_LINES} complete lines, newline-stripped, oldest-first.
 *
 * Behavior:
 *   - `undefined` / `""`  → `[]` (no log section to render)
 *   - Single line, no trailing newline → that line alone
 *   - Multi-line buffer  → last 20 complete lines; trailing partial line
 *     (no terminating `\n`) IS included if non-empty, so a service that
 *     crashed mid-line still has its dying gasp visible
 *   - CRLF normalized to LF before splitting so mixed-line-ending output
 *     (e.g. a Node service on Windows) renders cleanly
 *
 * The "include trailing partial" choice differs slightly from
 * `watchFailWhen` (which intentionally ignores partial lines to keep
 * regex-matching semantics consistent). Here the buffer is a post-mortem
 * snapshot and missing context would frustrate the user — better to render
 * a possibly-incomplete final line than to silently drop it.
 */
function extractLogTail(buffer: string | undefined): string[] {
  if (buffer === undefined || buffer.length === 0) return [];

  // Normalize CRLF → LF so the split below treats them identically. Doing
  // this before split (rather than per-line) avoids leaving stray \r at
  // the end of lines, which would render as a control character in
  // terminals that don't strip them.
  const normalized = buffer.replace(/\r\n/g, "\n");

  // Split on LF. The last element is "" iff the buffer ended with a
  // newline (because `"a\n".split("\n")` is `["a", ""]`). Drop that empty
  // trailing element so a user-friendly buffer ending in `\n` doesn't
  // look like the service emitted a blank line at the end.
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Tail to the last N — slice handles the case where there are fewer
  // than N lines gracefully (returns the whole array).
  if (lines.length <= LOG_TAIL_LINES) return lines;
  return lines.slice(lines.length - LOG_TAIL_LINES);
}

/**
 * Render a millisecond deadline as the shortest human-friendly string. We
 * use this in the timeout title/reason so `60000` reads as `"60s"` (matching
 * the user's likely `timeout: "60s"` config) rather than `"60000ms"`.
 *
 * Rules:
 *   - Whole hours (≥ 3_600_000 ms and divisible) → `"<n>h"`
 *   - Whole minutes (≥ 60_000 ms and divisible)  → `"<n>m"`
 *   - Whole seconds (≥ 1_000 ms and divisible)   → `"<n>s"`
 *   - Otherwise                                   → `"<ms>ms"`
 *
 * Keep this in sync with `parseDuration` in `ready/timeout.ts` — the same
 * four suffixes, the same precedence. A user's `"2m"` config should round-
 * trip back to `"2m"` in the failure title.
 */
function renderDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    // Defensive fallback. `withTimeout` only ever calls with the positive
    // ms it was constructed with, but if a malformed `ReadyTimeoutError`
    // ever propagates here we'd rather print the raw value than crash the
    // formatter.
    return `${ms}ms`;
  }
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Best-effort next-step hint for a failure. Returns `undefined` when no
 * recognized pattern applies — the formatter omits the `hint` field
 * entirely in that case so renderers don't print an empty hint line.
 *
 * The full set of recognized patterns is enumerated at the top of this
 * file. Adding a new hint here: keep the file-level enumeration in sync
 * with the case you add below.
 */
function inferHint(input: FailureInput): string | undefined {
  switch (input.kind) {
    case "fail_when": {
      // Two well-known patterns from the dogfood-stack's `api.fail_when`
      // log_match (`EADDRINUSE|Cannot find module`). We match against the
      // matched line itself rather than the original regex — what the user
      // saw in the log is the load-bearing signal, not what they configured
      // lich to watch for.
      if (input.matchedLine.includes("EADDRINUSE")) {
        return "hint: run `lich stacks` to find what's using the port";
      }
      if (input.matchedLine.includes("Cannot find module")) {
        return (
          "hint: run `bun install` (or your package manager equivalent) " +
          "in the service's directory"
        );
      }
      return undefined;
    }
    case "timeout": {
      return (
        "hint: increase ready_when.timeout or check the service is actually responding"
      );
    }
    case "capture_miss": {
      return (
        `hint: verify the regex matches the line the service actually printed; ` +
        `check \`lich logs ${input.service}\` for the full log`
      );
    }
    case "exit": {
      // Process exits cover too wide a surface for a generic hint — code 1
      // could mean anything from "test failed" to "config rejected" to "no
      // such file." Better to stay silent than to misdirect.
      return undefined;
    }
  }
}

/**
 * TypeScript exhaustiveness helper. Calling this in the default branch of
 * a discriminated-union switch makes the compiler refuse to build if a new
 * variant is added without a matching `case`. The runtime throw is a
 * belt-and-braces guard for the (impossible-in-typed-code) case where the
 * JS engine reaches the default.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled failure input variant: ${JSON.stringify(value)}`);
}
