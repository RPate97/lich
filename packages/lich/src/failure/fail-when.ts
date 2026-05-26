import type { LogTail } from "../logs/tail.js";

/**
 * Thrown by `watchFailWhen` when a log line matches the configured pattern.
 * Carries the matched line for the formatter to quote inline.
 */
export class FailWhenMatchedError extends Error {
  override readonly name = "FailWhenMatchedError";

  readonly matchedLine: string;

  constructor(matchedLine: string) {
    super(`fail_when matched: ${matchedLine}`);
    this.matchedLine = matchedLine;
  }
}

export interface WatchFailWhenOptions {
  /** LogTail lifecycle is owned by the caller; watchFailWhen only subscribes. */
  tail: LogTail;
  pattern: RegExp;
  signal?: AbortSignal;
}

/**
 * Watch for a `fail_when.log_match` pattern. Returned promise:
 *   - rejects with `FailWhenMatchedError` on first matching line (past or future)
 *   - rejects with `Error("aborted")` if `signal` fires
 *   - NEVER resolves
 *
 * Designed for `Promise.race` against `ready_when`. The caller MUST tear the
 * watcher down (abort the signal or stop the LogTail) if ready wins, otherwise
 * a late-arriving match becomes an unhandled rejection.
 */
export function watchFailWhen(
  opts: WatchFailWhenOptions,
): Promise<never> {
  const { tail, pattern, signal } = opts;

  return new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let abortListener: (() => void) | null = null;
    let settled = false;

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

    const fail = (err: Error): void => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    if (signal !== undefined) {
      abortListener = (): void => {
        fail(new Error("aborted"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    // Retroactive sweep: a fast-failing service may have emitted the line
    // before the watcher was wired up. Excludes the trailing partial line so
    // semantics match the live `onLine` path (which only emits complete lines).
    const buf = tail.buffer;
    if (buf.length > 0) {
      const lastNewline = buf.lastIndexOf("\n");
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

    if (settled) return;

    unsubscribe = tail.onLine((line) => {
      // LogTail snapshots its subscriber set before emitting, so a late
      // callback during the same emission burst is possible.
      if (settled) return;
      if (pattern.test(line)) {
        fail(new FailWhenMatchedError(line));
      }
    });
  });
}
