/**
 * log_match ready evaluator. Resolves when a line matching `pattern` is
 * observed on the supplied `LogTail`. Rejects with "aborted" on signal fire.
 *
 * Retroactive match: lines already in `tail.buffer` at call time are checked
 * BEFORE subscribing, to cover the window where the supervisor may have
 * written the matching line between spawn and our subscription. Only complete
 * (newline-terminated) lines are matched retroactively — partial trailing
 * content waits for `onLine` to emit it once the next newline arrives.
 */

import type { LogTail } from "../logs/tail.js";

export interface LogMatchReadySpec {
  /**
   * The shared LogTail for this service's log. Caller owns construction,
   * start, and stop; we only subscribe.
   */
  tail: LogTail;
  /** Compiled regex tested against each complete line (newline stripped). */
  pattern: RegExp;
  /** AbortSignal to cancel the wait. Subscription is cleaned up on any settle path. */
  signal?: AbortSignal;
}

/**
 * Returns a Promise that resolves when a line matching `pattern` is observed.
 * Rejects with "aborted" if `signal` fires. Subscription is removed from the
 * tail before the promise settles, on every path.
 */
export function waitForLogMatch(spec: LogMatchReadySpec): Promise<void> {
  const { tail, pattern, signal } = spec;

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    let unsubscribeLine: (() => void) | null = null;
    let onAbort: (() => void) | null = null;
    let settled = false;

    // Single-shot teardown so the subscriber callback, abort listener, and
    // buffer-scan path all funnel through one path — no double-settle, no
    // dangling subscriber on a still-alive tail.
    const settle = (kind: "ok" | "abort"): void => {
      if (settled) return;
      settled = true;

      if (unsubscribeLine !== null) {
        unsubscribeLine();
        unsubscribeLine = null;
      }
      if (signal !== undefined && onAbort !== null) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }

      if (kind === "ok") {
        resolve();
      } else {
        reject(new Error("aborted"));
      }
    };

    // Wire abort BEFORE the retroactive scan so a sibling-promise abort on
    // microtask zero gets caught here rather than landing on the subscriber.
    if (signal !== undefined) {
      onAbort = () => settle("abort");
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Retroactive scan: complete lines already buffered get a chance to match.
    // For buffer "a\nb\nc" split produces ["a", "b", "c"]; only "a" and "b" are
    // complete (followed by `\n`). "c" is partial — onLine will emit it later.
    const buffered = tail.buffer;
    if (buffered.length > 0) {
      const lines = buffered.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        if (pattern.test(lines[i]!)) {
          settle("ok");
          return;
        }
      }
    }

    unsubscribeLine = tail.onLine((line) => {
      if (settled) return; // defensive: stop() races against subscriber fan-out
      if (pattern.test(line)) {
        settle("ok");
      }
    });
  });
}
