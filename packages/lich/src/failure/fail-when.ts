/**
 * `fail_when.log_match` watcher (Plan 4 Task 7).
 *
 * Per-service sentinel that subscribes to a {@link LogTail} and rejects on
 * the first log line matching a user-supplied regex. Designed to race the
 * `ready_when` evaluator inside the orchestrator (`up.ts`) so a service that
 * fails to start without exiting (e.g. emits `EADDRINUSE` and hangs) still
 * surfaces as a failure rather than blocking the up forever.
 *
 * The contract is deliberately asymmetric with `ready_when`:
 *   - `ready_when` is a *state*: it resolves when the service is healthy.
 *   - `fail_when` is a *sentinel*: it NEVER resolves on its own. It only
 *     rejects (on match) or rejects (on abort). Callers race it against
 *     ready_when via `Promise.race`. If ready_when wins, the orchestrator
 *     MUST tear the watcher down (by aborting its signal or by ignoring
 *     the still-pending promise) so the sentinel can't fire late.
 *
 * The "never resolves" property is the load-bearing invariant. If the
 * watcher resolved on its own (e.g. after a timeout), the race would have
 * two winners — both ready and fail — and the orchestrator's downstream
 * logic would have to disambiguate. By making fail_when always *reject* on
 * fire (or abort) and *never* fulfill, the race is unambiguous: a fulfilled
 * outcome means ready_when won; a rejection means either fail_when matched,
 * the user cancelled, or ready_when itself threw.
 *
 * ### Retroactive match
 *
 * On subscription, the watcher first tests every line currently in
 * `LogTail.buffer` against the pattern. This handles the case where the
 * service emitted the failing line BEFORE the orchestrator wired up the
 * watcher (a race window: spawn → buffer fills → orchestrator constructs
 * LogTail → orchestrator constructs watcher). Without the retroactive
 * sweep, a sufficiently fast-failing service would slip past fail_when and
 * only be caught by ready_when's timeout. With it, the watcher catches
 * lines emitted at any point since `LogTail.start()` was called.
 *
 * After the retroactive sweep, the watcher subscribes via `LogTail.onLine`
 * for future lines. The unsubscribe returned by `onLine` is captured and
 * called in three cleanup paths: on match (so we don't re-fire), on abort
 * (so we don't leak the callback on a still-live LogTail), and implicitly
 * on stop (the LogTail's own teardown drops the subscriber set).
 *
 * ### Why a function not a class
 *
 * `ProcessExitWatcher` is a class because it caches `wait()`'s promise for
 * repeat calls. `watchFailWhen` is a function because it's strictly
 * one-shot — there's nothing to cache, no lifecycle beyond "fire once or
 * stay pending until aborted." The function returns a promise that the
 * caller stores in a race; that's the entire surface.
 */

import type { LogTail } from "../logs/tail.js";

/**
 * Error thrown by {@link watchFailWhen} when a log line matches the
 * configured `fail_when.log_match` pattern.
 *
 * Carries the matched line so the failure UX (Plan 4 Task 9
 * `formatter.ts`) can quote it inline — users want to see exactly which
 * log line tripped the sentinel, not just "fail_when matched."
 *
 * Discriminated by its class identity (`instanceof FailWhenMatchedError`)
 * AND by a stable `name: 'FailWhenMatchedError'` so cross-realm checks
 * (e.g. errors that pass through a worker boundary) still work. The
 * formatter dispatches on `name` to render the right block.
 */
export class FailWhenMatchedError extends Error {
  /** Stable name for cross-realm / serialization-based discrimination. */
  override readonly name = "FailWhenMatchedError";

  /**
   * The complete log line that matched the pattern (newline already
   * stripped by `LogTail`, so this is exactly what the failure block
   * renders). The orchestrator persists this into `state.json` as part
   * of `failure_log_tail`.
   */
  readonly matchedLine: string;

  constructor(matchedLine: string) {
    // The message is intentionally terse — the formatter (Task 9) renders
    // the rich failure block; this string is the fallback if something
    // logs the bare error (e.g. an unhandled rejection trace).
    super(`fail_when matched: ${matchedLine}`);
    this.matchedLine = matchedLine;
  }
}

/**
 * Options for {@link watchFailWhen}.
 *
 * Mirrors the shape of the other ready/failure primitives in this codebase
 * (`waitForLogMatch`, `ProcessExitWatcher`) so wiring them all in `up.ts`
 * reads uniformly.
 */
export interface WatchFailWhenOptions {
  /**
   * The shared `LogTail` for this owned service. The watcher uses it for
   * both retroactive matching (via the {@link LogTail.buffer} getter) and
   * forward subscription (via {@link LogTail.onLine}).
   *
   * The LogTail's lifecycle is OWNED BY THE CALLER. `watchFailWhen` never
   * calls `tail.stop()` — it only adds and removes a subscriber. This
   * matches the shape `up.ts` needs: one LogTail feeds many watchers, and
   * stopping the tail is the orchestrator's job at teardown.
   */
  tail: LogTail;

  /**
   * Compiled regex tested against each complete line. The caller compiles
   * ahead of time so syntax errors surface at `lich validate` (see
   * `commands/validate.ts`'s `checkRegexes`) rather than at startup time.
   * Plain `RegExp` so callers can use any flags they want (`u`, `i`, etc.).
   */
  pattern: RegExp;

  /**
   * Optional cancellation signal. When fired, the returned promise rejects
   * with an `aborted` error and the subscription is removed from the
   * LogTail. Used by the orchestrator to tie the watcher's lifetime to the
   * surrounding `lich up` invocation.
   *
   * Critically: an aborted signal at call time causes immediate rejection,
   * without ever subscribing or scanning the buffer. This prevents a
   * post-cancellation match from accidentally firing.
   */
  signal?: AbortSignal;
}

/**
 * Watch for a `fail_when.log_match` pattern on an owned service's log.
 *
 * Returns a promise with the following contract:
 *   - REJECTS with {@link FailWhenMatchedError} on the first log line
 *     (past or future) that matches `pattern`.
 *   - REJECTS with an `Error("aborted")` if `signal` fires before a match.
 *   - NEVER RESOLVES on its own. The caller must either get a match, abort
 *     the signal, or stop the underlying LogTail — there is no timeout, no
 *     natural completion.
 *
 * Designed for `Promise.race` against `ready_when`:
 *
 * ```ts
 * const controller = new AbortController();
 * try {
 *   await Promise.race([
 *     waitReady(...),                             // may resolve
 *     watchFailWhen({ tail, pattern, signal: controller.signal }), // never resolves
 *   ]);
 *   // ready won; tear the sentinel down so it can't fire late
 *   controller.abort();
 * } catch (err) {
 *   // either fail_when matched, ready threw, or we aborted
 * }
 * ```
 *
 * **Cleanup contract callers MUST honor:** if `ready_when` wins the race,
 * the caller has to ensure the fail_when watcher is torn down — either by
 * aborting its `signal` or by stopping the underlying LogTail. Otherwise
 * a late-arriving log line (post-ready) would still trigger a rejection
 * on the dead promise, which Node surfaces as an unhandled rejection.
 *
 * @returns a promise that fits the "never resolves; only rejects" contract.
 *   Typed as `Promise<never>` so `Promise.race` infers the union correctly
 *   (the fulfilled type comes from the other racer; this one contributes
 *   only rejection paths).
 */
export function watchFailWhen(
  opts: WatchFailWhenOptions,
): Promise<never> {
  const { tail, pattern, signal } = opts;

  return new Promise<never>((_resolve, reject) => {
    // Fast path: already aborted. Surface immediately without touching
    // the LogTail. Matches the early-abort shape of `waitForLogMatch`
    // and ensures a cancelled-before-call invocation leaves no
    // subscription behind.
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    // Mutable: nulled by whichever cleanup path fires first. Used as a
    // guard so we never call `reject` twice, never call unsubscribe
    // twice, never remove an abort listener that was already auto-removed
    // by `{ once: true }`.
    let unsubscribe: (() => void) | null = null;
    let abortListener: (() => void) | null = null;
    let settled = false;

    /**
     * Common teardown — runs on EVERY exit path (match, abort, or any
     * future addition). Centralizing this here avoids the bug-prone
     * pattern of duplicating cleanup at each rejection site. Idempotent
     * via the `settled` flag.
     */
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      if (signal !== undefined && abortListener !== null) {
        signal.removeEventListener("abort", abortListener);
        abortListener = null;
      }
    };

    /**
     * Reject the promise and tear down. Wrapped so cleanup-then-reject
     * is atomic — if the LogTail emits another matching line during
     * teardown (it shouldn't, since `unsubscribe()` is synchronous, but
     * defense-in-depth), the `settled` guard ensures we only reject
     * once.
     */
    const fail = (err: Error): void => {
      // Snapshot the cleanup-completed state BEFORE rejecting, in case
      // the rejection handler synchronously triggers something that
      // re-enters this watcher (unlikely but cheap to defend against).
      if (settled) return;
      cleanup();
      reject(err);
    };

    // Wire abort first so an abort during the retroactive sweep (which
    // is technically synchronous, but for safety) still rejects cleanly.
    // The `{ once: true }` flag means the listener auto-removes after
    // firing; `cleanup` still calls `removeEventListener` in the
    // not-yet-fired case to prevent retaining `this` on a long-lived
    // signal (matches the LogTail pattern).
    if (signal !== undefined) {
      abortListener = (): void => {
        fail(new Error("aborted"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    // Retroactive sweep: test every COMPLETE line in the LogTail buffer
    // against the pattern. If any match, fail immediately without
    // subscribing — the failure already happened, the watcher just
    // hadn't noticed yet.
    //
    // Splitting on /\r?\n/ matches LogTail's line emission (which also
    // strips CRLF), so a regex like `EADDRINUSE` matches identically
    // whether the line came in via retroactive scan or live emission.
    //
    // The trailing partial line (no terminating newline) is INTENTIONALLY
    // excluded — `LogTail.onLine` only emits complete lines, so a regex
    // that only matches partial-line bytes would be inconsistent between
    // the two paths. The forward subscription will pick up the partial
    // line once it completes.
    const buf = tail.buffer;
    if (buf.length > 0) {
      const lastNewline = buf.lastIndexOf("\n");
      // Slice to the last newline; everything past it is a partial line
      // we ignore. If no newline at all, there are no complete lines yet.
      if (lastNewline >= 0) {
        const completePortion = buf.slice(0, lastNewline);
        const lines = completePortion.split(/\r?\n/);
        for (const line of lines) {
          if (pattern.test(line)) {
            fail(new FailWhenMatchedError(line));
            return;
          }
        }
      }
    }

    // Settled during the retroactive sweep (matched or aborted)? Don't
    // subscribe — we're done. This also handles the synchronous-abort
    // case where the signal fired during the buffer loop.
    if (settled) return;

    // Forward subscription. The callback fires synchronously inside the
    // LogTail poll loop for every new complete line. We test, and on
    // match: tear down, reject. Lines after the first match are ignored
    // because `cleanup` removes our subscription before emission of the
    // next line.
    unsubscribe = tail.onLine((line) => {
      // The `settled` check is defense-in-depth: by the time we get
      // here, `cleanup()` should have removed our subscription, so this
      // callback shouldn't be invoked at all. But LogTail snapshots
      // its subscriber set before emitting (see `LogTail.emitLine`), so
      // a late callback during the same emission burst is possible.
      // Skip it.
      if (settled) return;
      if (pattern.test(line)) {
        fail(new FailWhenMatchedError(line));
      }
    });
  });
}
