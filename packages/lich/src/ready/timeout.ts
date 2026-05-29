/**
 * `ready_when.timeout` wrapper and `parseDuration` helper.
 *
 * `withTimeout` bounds a ready evaluator with a deadline, throwing
 * `ReadyTimeoutError` on expiry. Content-agnostic by design: doesn't know
 * what the wrapped promise is doing — `phase` is the only caller-supplied
 * label. Does NOT cancel the wrapped promise; wire an AbortSignal into the
 * evaluator separately if you need to release resources on timeout.
 */

/**
 * Thrown by `withTimeout` on deadline expiry. The failure formatter
 * discriminates via `instanceof` — do NOT swallow or rewrap without
 * preserving the relationship.
 */
export class ReadyTimeoutError extends Error {
  /** The deadline that elapsed, in milliseconds. */
  readonly ms: number;
  /** Optional label naming the ready evaluator (e.g. `"http_get"`). */
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

export interface WithTimeoutOptions {
  /** Deadline in milliseconds. */
  ms: number;
  /** Optional label naming the ready evaluator (e.g. `"http_get"`). */
  phase?: string;
}

/**
 * Race `promise` against a `ms`-millisecond deadline. Mirrors the promise's
 * settlement if it wins; rejects with `ReadyTimeoutError` if the deadline does.
 * Internal timer is cleared on either path.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  msOrOptions: number | WithTimeoutOptions,
): Promise<T> {
  const opts: WithTimeoutOptions =
    typeof msOrOptions === "number" ? { ms: msOrOptions } : msOrOptions;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ReadyTimeoutError(opts));
    }, opts.ms);

    // unref so the process can exit naturally if the timeout is the only
    // thing keeping the event loop alive.
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

/**
 * Parse a duration accepted by `ready_when.timeout`:
 *   - `"500ms"` → 500
 *   - `"30s"` → 30_000
 *   - `"2m"` → 120_000
 *   - `"1h"` → 3_600_000
 *   - bare integer → milliseconds
 *
 * Strict grammar (matches the schema): rejects floats, negatives, zero,
 * unknown suffixes, the empty string. We avoid the `ms` npm package so a
 * typo like `"5 minutes"` fails loudly rather than being silently accepted.
 */
export function parseDuration(value: string | number): number {
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

  if (typeof value !== "string") {
    // Defensive: TypeScript callers shouldn't reach here.
    throw new Error(
      `invalid duration: expected string or number, got ${typeof value}`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid duration: expected a value, got empty string`);
  }

  // Pattern mirrors the schema's `^[0-9]+(ms|s|m|h)?$`.
  const match = /^([0-9]+)(ms|s|m|h)?$/.exec(trimmed);
  if (match === null) {
    throw new Error(
      `invalid duration: "${value}" — expected a positive integer optionally followed by "ms", "s", "m", or "h" (e.g. "500ms", "30s", "2m", "1h")`,
    );
  }

  const digits = match[1]!;
  const suffix = match[2];
  const n = Number.parseInt(digits, 10);
  if (n <= 0) {
    // parseInt("0") succeeds; regex allows leading zeros. Reject explicitly.
    throw new Error(
      `invalid duration: "${value}" — must be positive (got 0)`,
    );
  }

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
      // Unreachable given the regex; a future suffix addition that updates
      // the regex but forgets the switch fails loudly here.
      throw new Error(
        `invalid duration: "${value}" — unknown suffix "${suffix}"`,
      );
  }
}
