/**
 * log_match ready evaluator — refactored to consume a {@link LogTail}.
 *
 * Plan 4 introduced the `LogTail` primitive (`packages/lich/src/logs/tail.ts`)
 * to fan one physical log file out to N logical consumers: `ready_when.log_match`,
 * `fail_when.log_match`, `ready_when.capture`, and (Plan 5) the dashboard live
 * tail. Each of those consumers used to need its own poll loop, its own read
 * fd, and its own line-splitting state. Plan 4 Task 4 finishes that cleanup by
 * removing this file's standalone poll loop and re-expressing it as a
 * subscriber on a caller-supplied `LogTail`.
 *
 * ### Behavior contract (preserved from the standalone implementation)
 *
 * Resolves when a line matching `pattern` is observed. Rejects with an error
 * whose message contains "aborted" if the caller's `signal` fires (or is
 * already aborted at entry). The supplied `tail` is the I/O surface; this
 * function only inspects lines it produces.
 *
 * Regex compilation is the caller's responsibility — `validate` compiles the
 * user-supplied pattern up front so syntax errors surface at config load, not
 * at ready-check time.
 *
 * ### Retroactive match (the new piece)
 *
 * `up.ts` will spawn an owned service, construct a `LogTail`, then call
 * `waitForLogMatch`. The supervisor may already have written some bytes — and
 * possibly the matching ready line — into the log between spawn and our
 * subscription. Subscribing via `tail.onLine(...)` only sees NEW lines, so we
 * could miss a ready line that landed during that startup window.
 *
 * To close the window, we check `tail.buffer.split(/\r?\n/)` against `pattern`
 * BEFORE subscribing. Any complete line already in the buffer that matches
 * wins immediately. If nothing in the buffer matches, we subscribe to new
 * lines and wait for the first match (or abort).
 *
 * Note that `tail.buffer` is the accumulator the `LogTail` populates on each
 * read — it contains every byte the LogTail has read since `start()`, with the
 * trailing partial line included verbatim. That partial line is excluded by
 * the `split(/\r?\n/)` filter below (we only consider complete-newline-terminated
 * lines) because the `LogTail`'s `onLine()` subscriber contract is "complete
 * lines only"; we want our retroactive scan to honor the same rule.
 *
 * ### Why this no longer opens its own fd
 *
 * Before Plan 4 Task 4 this file ran its own `setInterval` + `stat` + `open`
 * + `read` loop. That worked, but it meant every Plan 4 consumer (fail_when,
 * capture, dashboard) would duplicate the same machinery and re-open the same
 * file N times per poll tick. `LogTail` owns the read side now; this file
 * owns the regex-matching side. Each does one thing.
 */

import type { LogTail } from "../logs/tail.js";

export interface LogMatchReadySpec {
  /**
   * The shared LogTail for this service's log. The caller (`up.ts`) is
   * responsible for constructing, starting, and ultimately stopping the
   * tail — we just subscribe to it. Multiple watchers (fail_when, capture)
   * subscribe to the same instance.
   */
  tail: LogTail;
  /**
   * Compiled regex. Tested against each complete line (newline stripped).
   * Caller compiles ahead of time so validate can catch syntax errors.
   */
  pattern: RegExp;
  /**
   * Optional AbortSignal to cancel the wait. On fire, the returned promise
   * rejects with an Error whose message contains "aborted". Subscribing to
   * the tail is cleaned up on either path (match or abort) so the LogTail
   * doesn't accumulate dead subscribers.
   */
  signal?: AbortSignal;
}

/**
 * Returns a Promise that resolves when a line matching `pattern` is observed
 * via `spec.tail`. Rejects if the supplied `signal` fires.
 *
 * Lines already in `spec.tail.buffer` at call time are inspected first — see
 * the file-level docstring's "Retroactive match" section for why this matters.
 * If nothing in the buffer matches, we subscribe via `tail.onLine(...)` and
 * resolve on the first matching new line.
 *
 * Cleanup contract: whichever way the promise settles (resolve on match,
 * reject on abort, or pre-aborted at entry), the subscription is removed from
 * the LogTail before the promise settles. This keeps the LogTail's subscriber
 * set bounded across the orchestrator's lifetime.
 */
export function waitForLogMatch(spec: LogMatchReadySpec): Promise<void> {
  const { tail, pattern, signal } = spec;

  return new Promise<void>((resolve, reject) => {
    // Pre-aborted: reject synchronously after the microtask boundary so
    // callers can `await` without observing a thenable that resolves
    // mid-construction. Matches the standalone implementation's behavior.
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    // unsubscribeLine is set after we register the line subscriber below.
    // It's invoked from settle() to remove our callback from the tail's
    // subscriber set. `null` before subscription is meaningful: it lets
    // settle() know there's nothing to remove yet (e.g. retroactive match
    // path that resolves before subscribing).
    let unsubscribeLine: (() => void) | null = null;
    // onAbort is captured so we can `removeEventListener` it on settle.
    // Otherwise a long-lived AbortSignal (the orchestrator's) would keep a
    // reference to this closure for every log_match wait we ever did.
    let onAbort: (() => void) | null = null;
    let settled = false;

    /**
     * Single-shot termination path. Calls every cleanup hook exactly once,
     * then invokes the supplied disposition. Designed so the subscriber
     * callback, the abort listener, and the buffer-scan path all funnel
     * through the same teardown — no chance of resolving twice, no chance
     * of leaving a subscriber dangling on a tail that's still alive.
     */
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

    // Wire abort handling first so a signal that fires synchronously
    // during our retroactive buffer scan (unlikely, but a sibling
    // promise that aborts on microtask zero would otherwise sneak past)
    // gets caught here rather than landing on the subscriber.
    if (signal !== undefined) {
      onAbort = () => settle("abort");
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Retroactive scan: any complete line already buffered by the tail
    // BEFORE we subscribed gets a chance to match. The trailing partial
    // line (no terminating newline) is excluded by `split(/\r?\n/)` only
    // emitting elements separated by complete newlines — the final
    // element after a trailing partial is still a possibly-incomplete
    // line, so we deliberately only test elements that have a successor
    // in the array (i.e. they were followed by a newline in the buffer).
    //
    // Concretely: for buffer "a\nb\nc" (no trailing newline), split
    // produces ["a", "b", "c"]. Only "a" and "b" are complete (followed
    // by `\n` in the source); "c" is partial and excluded from the
    // retroactive scan. The LogTail's `onLine` will emit "c" later, once
    // the next `\n` arrives, so we'll see it then.
    const buffered = tail.buffer;
    if (buffered.length > 0) {
      const lines = buffered.split(/\r?\n/);
      // Iterate up to length-1: the final element is the (possibly
      // empty) tail after the last `\n`. If the buffer ends with `\n`,
      // that tail is "" and there's nothing to test. If the buffer ends
      // mid-line, that tail is a partial line we shouldn't match against
      // (the `onLine` subscriber will see it when it's complete).
      for (let i = 0; i < lines.length - 1; i++) {
        if (pattern.test(lines[i]!)) {
          settle("ok");
          return;
        }
      }
    }

    // No retroactive match. Subscribe to new lines. Each line emission is
    // tested in registration order — first match wins.
    unsubscribeLine = tail.onLine((line) => {
      if (settled) return; // defensive: stop() races against subscriber fan-out
      if (pattern.test(line)) {
        settle("ok");
      }
    });
  });
}
