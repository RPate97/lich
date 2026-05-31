/**
 * `ready_when.extend_on_progress` wrapper. Wraps a ready evaluator with a
 * "silence deadline" instead of a wall-clock deadline: each new log line
 * observed on the supplied `LogTail` resets the timer. Total wait is
 * unbounded as long as the service keeps emitting output. Fails with
 * `ReadyTimeoutError` (carrying `ms`) only if the service goes silent for
 * longer than `ms` milliseconds.
 *
 * Used in place of `withTimeout` when `ready_when.extend_on_progress: true`.
 * Same rejection class so the failure formatter renders identical wording.
 */

import { ReadyTimeoutError, type WithTimeoutOptions } from "./timeout.js";
import type { LogTail } from "../logs/tail.js";

export interface WithProgressTimeoutOptions extends WithTimeoutOptions {
  /** Tail whose `onLine` events reset the silence deadline. */
  tail: LogTail;
}

/**
 * Race `promise` against a silence-only deadline. Each line emitted by `tail`
 * resets the `ms`-millisecond timer. Rejects with `ReadyTimeoutError` if the
 * service is quiet for more than `ms` between lines. Mirrors the wrapped
 * promise's settlement otherwise. The internal timer and subscription are
 * cleaned up on every settle path.
 */
export function withProgressTimeout<T>(
  promise: Promise<T>,
  opts: WithProgressTimeoutOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const armTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const errOpts: WithTimeoutOptions = { ms: opts.ms };
        if (opts.phase !== undefined) errOpts.phase = opts.phase;
        reject(new ReadyTimeoutError(errOpts));
      }, opts.ms);
      timer.unref?.();
    };

    armTimer();

    unsubscribe = opts.tail.onLine(() => {
      if (settled) return;
      armTimer();
    });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}
