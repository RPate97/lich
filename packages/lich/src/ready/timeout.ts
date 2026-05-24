/**
 * `ready_when.timeout` wrapper — bound the ready-evaluator promise to a
 * deadline and surface a recognizable error type on expiry (Plan 4 Task 5).
 *
 * Use case: a service whose `cmd` runs but never satisfies its `ready_when`
 * condition would otherwise wedge `lich up` indefinitely. Wrapping each
 * ready evaluator (`waitForHttpReady`, `waitForTcpReady`, `waitForLogMatch`)
 * with `withTimeout` guarantees the orchestrator either gets `ready`,
 * `aborted`, or a {@link ReadyTimeoutError} — never an indefinite hang.
 *
 * ### Why a standalone primitive (vs reusing supervisor.ts's pattern)
 *
 * `supervisor.ts` has an inline `withTimeout`-shaped helper for `stop_cmd`
 * supervision. That one is purpose-built: it understands process handles, it
 * kills on expiry, and its error type is supervisor-specific. The ready
 * pipeline needs a CONTENT-AGNOSTIC primitive — `withTimeout(p, ms)` that
 * doesn't know what `p` is doing, and a dedicated error class (Plan 4's
 * `formatter.ts` detects `ReadyTimeoutError` via `instanceof` to render the
 * timeout block with the phase + duration). Keeping the two helpers separate
 * avoids cross-coupling and keeps each one's contract narrow.
 *
 * ### Default timeout policy lives in the caller (NOT here)
 *
 * The spec sets the default `ready_when.timeout` to `60s` if unset. That
 * default is applied in `up.ts` (Plan 4 Task 14) before calling `withTimeout`
 * — this file stays content-agnostic. Reason: a future feature may want a
 * different default per evaluator (e.g. log_match could default to shorter
 * since logs arrive immediately if at all), and pushing the default down
 * here would tangle the policy with the mechanism.
 *
 * ### Cleanup contract
 *
 * On either resolution path (wrapped promise wins, or deadline wins), the
 * `setTimeout` timer is cleared so the event loop can exit cleanly. The
 * wrapped promise is NOT cancelled by `withTimeout` itself — that's the
 * caller's job (usually via an `AbortSignal` plumbed into the evaluator's
 * own polling loop). `withTimeout` only races; the cancellation choreography
 * belongs at a level that understands what to abort.
 */

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link withTimeout} when the deadline elapses before the wrapped
 * promise settles.
 *
 * Carries the configured duration (`ms`) so the failure formatter can render
 * "did not become ready within 30s", and an optional `phase` label so the
 * formatter can disambiguate WHICH ready evaluator timed out (e.g.
 * `"http_get"`, `"log_match"`). Phase is optional because some call sites
 * race multiple evaluators and don't know which one was the slow one — in
 * that case omitting the label is honest.
 *
 * The orchestrator's `formatter.ts` (Plan 4 Task 9) uses `instanceof
 * ReadyTimeoutError` to discriminate timeouts from other failure kinds; do
 * NOT swallow this error or rewrap it without preserving the `instanceof`
 * relationship.
 */
export class ReadyTimeoutError extends Error {
  /** The deadline that elapsed, in milliseconds. */
  readonly ms: number;
  /**
   * Optional label naming which ready evaluator timed out (e.g.
   * `"http_get"`). Set by the caller when meaningful; omitted otherwise.
   */
  readonly phase?: string;

  constructor(opts: { ms: number; phase?: string }) {
    const phaseSuffix = opts.phase ? ` during ${opts.phase}` : "";
    super(`ready_when timeout after ${opts.ms}ms${phaseSuffix}`);
    this.name = "ReadyTimeoutError";
    this.ms = opts.ms;
    if (opts.phase !== undefined) {
      this.phase = opts.phase;
    }
  }
}

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

/**
 * Options for {@link withTimeout}'s second-arity form. We accept either
 * `withTimeout(promise, ms)` (the common case — bare millisecond deadline)
 * or `withTimeout(promise, { ms, phase })` (when the caller knows which
 * evaluator phase to label in the error).
 */
export interface WithTimeoutOptions {
  /** Deadline in milliseconds. */
  ms: number;
  /**
   * Optional label naming which ready evaluator this deadline guards (e.g.
   * `"http_get"`, `"log_match"`). Forwarded into {@link ReadyTimeoutError}
   * on expiry so the failure formatter can render the phase.
   */
  phase?: string;
}

/**
 * Race `promise` against a `ms`-millisecond deadline. If `promise` settles
 * first, the returned promise mirrors its settlement (resolve OR reject).
 * If the deadline wins, the returned promise rejects with a
 * {@link ReadyTimeoutError} carrying the configured `ms` and optional
 * `phase` label.
 *
 * The internal `setTimeout` is cleared on either resolution path so the
 * event loop can drain. The wrapped promise is NOT cancelled by
 * `withTimeout` (it doesn't know how) — wire an `AbortSignal` into the
 * evaluator separately if you need to release its underlying resources on
 * timeout.
 *
 * Content-agnostic by design: this primitive doesn't know whether `promise`
 * is polling HTTP, watching a log, or doing arbitrary work. The `phase`
 * label is the only escape hatch for caller-supplied context.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  msOrOptions: number | WithTimeoutOptions,
): Promise<T> {
  const opts: WithTimeoutOptions =
    typeof msOrOptions === "number" ? { ms: msOrOptions } : msOrOptions;

  return new Promise<T>((resolve, reject) => {
    // Track which side won so the loser's settlement is ignored. Both the
    // wrapped promise and the timer could fire in rapid succession; we want
    // only the first to settle the outer promise.
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ReadyTimeoutError(opts));
    }, opts.ms);

    // Allow the process to exit naturally if this is the only thing keeping
    // the event loop alive. Without `unref`, a long timeout would block
    // graceful shutdown of test harnesses and short-lived scripts.
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

/**
 * Parse a duration value as accepted by `ready_when.timeout`:
 *   - `"500ms"`              → 500
 *   - `"30s"`, `"60s"`       → 30_000, 60_000
 *   - `"2m"`                 → 120_000
 *   - `"1h"`                 → 3_600_000
 *   - `60000` (raw integer)  → 60_000 (interpreted as milliseconds)
 *
 * Throws `Error` on any malformed input: non-positive numbers, numbers with
 * a decimal point, strings with unknown suffixes, strings with a negative
 * sign, the empty string, `null`/`undefined`-shaped inputs, etc.
 *
 * ### Why a separate parser (vs `ms` npm package)
 *
 * The `ms` package accepts a wider grammar than the spec ("2 minutes", "2
 * mins", arbitrary whitespace, etc.). The lich.yaml surface is small and
 * we want exactly the four suffixes documented in the spec — keeping
 * parsing strict makes config-typo errors precise. A user who writes
 * `"5 minutes"` should see "unknown duration suffix" rather than silent
 * success with possibly-wrong semantics.
 *
 * ### Integer semantics
 *
 * A raw integer (no suffix) is interpreted as milliseconds. This matches
 * the schema's accept-either-`string`-or-`integer` rule (the schema rejects
 * negatives and zero, but the parser double-checks to keep it safe for any
 * pre-validated raw call). The same `60_000` value can be written as `"60s"`,
 * `"60000"`, `"60000ms"`, or as the bare integer `60000`.
 */
export function parseDuration(value: string | number): number {
  // ---- raw integer path ------------------------------------------------
  // Accept exactly the JS-number subset that the schema accepts: positive
  // integers. Floats, NaN, Infinity, zero, and negatives all fail loudly.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `invalid duration: expected a positive integer (ms), got ${value}`,
      );
    }
    if (!Number.isInteger(value)) {
      throw new Error(
        `invalid duration: expected an integer (ms), got ${value} (use a suffix like "500ms" if you meant a fractional duration)`,
      );
    }
    if (value <= 0) {
      throw new Error(
        `invalid duration: expected a positive integer (ms), got ${value}`,
      );
    }
    return value;
  }

  // ---- string path -----------------------------------------------------
  // The grammar is strict: digits (no leading sign, no decimal) optionally
  // followed by one of `ms`, `s`, `m`, `h`. The regex below is the
  // authoritative parser; we re-derive any error messages from the failed
  // matches rather than inferring intent.
  if (typeof value !== "string") {
    // Defensive: TypeScript callers shouldn't reach here, but the
    // surrounding parse-then-call dance from the orchestrator could
    // theoretically pass through a value the type system mis-narrowed.
    throw new Error(
      `invalid duration: expected string or number, got ${typeof value}`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid duration: expected a value, got empty string`);
  }

  // The pattern mirrors the schema's `^[0-9]+(ms|s|m|h)?$` so the parser
  // accepts exactly what validation lets through. Capture group 1 is the
  // digit run; group 2 is the optional suffix.
  const match = /^([0-9]+)(ms|s|m|h)?$/.exec(trimmed);
  if (match === null) {
    // Give the user the same error whether they typed `"forever"` or
    // `"5 minutes"` — pointing at the grammar is more useful than trying
    // to disambiguate every malformed shape.
    throw new Error(
      `invalid duration: "${value}" — expected a positive integer optionally followed by "ms", "s", "m", or "h" (e.g. "500ms", "30s", "2m", "1h")`,
    );
  }

  const digits = match[1]!;
  const suffix = match[2]; // undefined when no suffix written
  const n = Number.parseInt(digits, 10);
  if (n <= 0) {
    // `parseInt("0", 10)` succeeds; the regex doesn't ban leading zeros.
    // Reject zero explicitly so callers can rely on the return being > 0.
    throw new Error(
      `invalid duration: "${value}" — must be positive (got 0)`,
    );
  }

  // Suffix → millisecond multiplier table. `undefined` means the user wrote
  // a bare integer-as-string (e.g. `"60000"`) which we treat as already-ms.
  // Kept inline (vs a const map) so the call site reads top-to-bottom: each
  // case is one line, the math is visible.
  switch (suffix) {
    case undefined:
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      // Unreachable given the regex; kept so a future suffix addition
      // (e.g. `"d"`) that updates the regex but forgets the switch fails
      // loudly instead of silently dropping into a default behavior.
      throw new Error(
        `invalid duration: "${value}" — unknown suffix "${suffix}"`,
      );
  }
}
