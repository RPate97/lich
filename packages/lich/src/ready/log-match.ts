/**
 * log_match ready evaluator.
 *
 * Tails a service's per-service log file (the supervisor writes one per
 * owned service to disk) and resolves when a line matching `pattern` is
 * observed. Plan 1 is pass/fail only — Plan 4 will add `capture:`
 * (named-group extraction).
 *
 * Strategy: poll `stat` on the log path on a short interval. If the file
 * has grown since the last read, read the new bytes from the previous
 * offset, split into lines, and test each complete line against the
 * regex. A trailing partial line (no terminating newline) is buffered
 * across ticks so the pattern only ever matches complete lines.
 *
 * If the file doesn't exist yet (the service may not have produced any
 * output, or hasn't started), poll until it appears.
 *
 * The supplied AbortSignal cancels the polling loop and any in-flight
 * read; on abort the returned promise rejects with an Error whose
 * message contains "aborted".
 *
 * Regex compilation is the caller's responsibility — `validate` compiles
 * the user-supplied pattern up front so syntax errors surface at config
 * load, not at ready-check time.
 */

import { open, stat } from "node:fs/promises";

export interface LogMatchReadySpec {
  /** Absolute path to the log file to watch. */
  logPath: string;
  /**
   * Compiled regex. Tested against each complete line (newline stripped).
   * Caller compiles ahead of time so validate can catch syntax errors.
   */
  pattern: RegExp;
  /**
   * Poll interval in ms. Default 100. Faster than http/tcp because
   * file-system polling is cheap.
   */
  intervalMs?: number;
  /** Optional AbortSignal to cancel the polling loop. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 100;

/**
 * Returns a Promise that resolves when a line matching `pattern` is
 * observed in the log file. Rejects if the supplied AbortSignal fires.
 */
export async function waitForLogMatch(spec: LogMatchReadySpec): Promise<void> {
  const intervalMs = spec.intervalMs ?? DEFAULT_INTERVAL_MS;
  const outerSignal = spec.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  let offset = 0;
  // Trailing partial-line buffer: a chunk of bytes that didn't end with
  // a newline; we hold it so the next tick can finish the line before
  // testing against the regex.
  let pending = "";

  // Loop forever (no timeout in Plan 1). Each tick:
  //   1. stat the file (ENOENT → file not yet present; sleep + retry)
  //   2. if size > offset → open, read the new bytes, close
  //   3. split into complete lines (carry partial)
  //   4. test each line; resolve on first match
  //   5. sleep intervalMs
  // Abort can fire at any point — both during reads and during the sleep.
  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    let size: number | null = null;
    try {
      const st = await stat(spec.logPath);
      size = st.size;
    } catch (err) {
      // ENOENT is expected before the service starts writing. Any other
      // error is also non-fatal — just keep polling. If abort fired
      // mid-stat, surface it.
      if (outerSignal?.aborted) {
        throw new Error("aborted");
      }
    }

    if (size !== null && size > offset) {
      // Read the new bytes.
      const length = size - offset;
      const buf = Buffer.allocUnsafe(length);
      const handle = await open(spec.logPath, "r");
      try {
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        offset += bytesRead;

        if (bytesRead > 0) {
          const chunk = buf.slice(0, bytesRead).toString("utf8");
          pending += chunk;

          // Split on newline. Everything before the last newline is a
          // set of complete lines; anything after is a partial we carry.
          const lastNewline = pending.lastIndexOf("\n");
          if (lastNewline >= 0) {
            const complete = pending.slice(0, lastNewline);
            pending = pending.slice(lastNewline + 1);

            // Split off the complete portion line-by-line. `split('\n')`
            // on the complete portion gives us each line cleanly (no
            // trailing empty element since we stripped the final '\n').
            // Use `split(/\r?\n/)` so CRLF logs aren't matched with a
            // stray '\r' at the end of the line.
            const lines = complete.split(/\r?\n/);
            for (const line of lines) {
              if (spec.pattern.test(line)) {
                await handle.close();
                return;
              }
            }
          }
        }
      } finally {
        // `close` may throw if we already closed above on match — wrap.
        try {
          await handle.close();
        } catch {
          // already closed
        }
      }
    }

    // If the file shrunk (rotation) we don't try to handle it in Plan 1.
    // The supervisor doesn't rotate; if size < offset somehow we leave
    // the offset alone and wait for it to grow past `offset` again,
    // which is conservative but safe.

    await sleep(intervalMs, outerSignal);
  }
}

/**
 * Sleep for `ms` milliseconds, returning early (rejecting with "aborted")
 * if the supplied signal fires.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
