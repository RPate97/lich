/**
 * `ready_when.capture` evaluator — extract named values from a service's log
 * buffer at the moment readiness fires. Use case: a Cloudflare tunnel URL
 * printed once on startup, a port chosen by the framework when `0` is passed —
 * surfaced as `${owned.<name>.captured.<key>}` for later services to interpolate.
 *
 * Synchronous: `runCapture` only inspects `LogTail.buffer`, already populated
 * by the polling loop. Called immediately after `ready_when` resolves, so the
 * buffer contains everything since `LogTail.start()`.
 *
 * Single-group convention: each regex captures group 1 if a capturing group
 * exists, otherwise the full match (group 0). Multiple groups not supported —
 * declare two captures with separate patterns instead.
 *
 * First-match semantics: `exec` without the `g` flag stops at the first hit
 * (the moment-of-readiness snapshot). A regex with no match throws
 * `CaptureMissError` on the FIRST missing key in declaration order.
 */

import type { LogTail } from "../logs/tail.js";

/** Thrown when a `ready_when.capture` regex finds no match in the log buffer. */
export class CaptureMissError extends Error {
  readonly key: string;
  readonly pattern: string;

  constructor(opts: { key: string; pattern: string }) {
    super(
      `ready_when.capture key "${opts.key}" did not match any line in the service log ` +
        `(pattern: ${opts.pattern})`,
    );
    this.name = "CaptureMissError";
    this.key = opts.key;
    this.pattern = opts.pattern;
  }
}

export interface RunCaptureOptions {
  /** The per-service LogTail. Only `.buffer` is read; never subscribed. */
  tail: LogTail;
  /** User-declared `ready_when.capture` map: pattern strings keyed by capture name. */
  patterns: Record<string, string>;
}

/**
 * Run each `ready_when.capture` regex against the service's log buffer. Returns
 * `Record<capture key, matched value>`. Throws `CaptureMissError` on the first
 * key with no match.
 */
export function runCapture(opts: RunCaptureOptions): Record<string, string> {
  const { tail, patterns } = opts;
  // Snapshot once: the LogTail poll loop may run concurrently and two reads
  // could observe different lengths.
  const buffer = tail.buffer;
  const result: Record<string, string> = {};

  for (const [key, pattern] of Object.entries(patterns)) {
    // `u` flag matches the validate step's compile policy so "passes validate"
    // implies "compiles cleanly here". No `g` flag — `exec` without `g` always
    // starts from position 0 (we don't want stateful `lastIndex`).
    const re = new RegExp(pattern, "u");
    const match = re.exec(buffer);
    if (match === null) {
      throw new CaptureMissError({ key, pattern });
    }

    // If the regex defines a capturing group, take group 1; otherwise group 0.
    // `?? ""` covers an optional capturing group that didn't participate
    // (e.g. `(a)?`) — empty string is the conservative "matched, no content".
    if (match.length > 1) {
      result[key] = match[1] ?? "";
    } else {
      result[key] = match[0];
    }
  }

  return result;
}
