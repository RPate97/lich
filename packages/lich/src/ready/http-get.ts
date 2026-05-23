/**
 * http_get ready evaluator.
 *
 * Polls an HTTP GET endpoint at a fixed interval; resolves when the
 * endpoint responds with a 2xx status. Network errors / connection
 * refused / 4xx / 5xx all cause the loop to keep polling. Plan 1 has
 * NO timeout — callers wrap with a timeout in Plan 4.
 *
 * The supplied AbortSignal cancels both any in-flight fetch and the
 * inter-attempt sleep; on abort the returned promise rejects with an
 * Error whose message contains "aborted".
 */

export interface HttpGetReadySpec {
  /**
   * Full URL to poll, e.g. `http://localhost:5847/health`. The caller
   * (interpolation engine, later) substitutes `${owned.X.port}` and
   * friends into the URL before passing it here.
   */
  url: string;
  /**
   * Polling interval in milliseconds between attempts. Defaults to 250.
   */
  intervalMs?: number;
  /**
   * Optional AbortSignal to cancel the polling loop (e.g. for SIGINT
   * propagation). When aborted, the returned promise rejects.
   */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 250;

/**
 * Returns a Promise that resolves when `GET <url>` returns a 2xx
 * response. Rejects if the supplied AbortSignal fires.
 */
export async function waitForHttpReady(spec: HttpGetReadySpec): Promise<void> {
  const intervalMs = spec.intervalMs ?? DEFAULT_INTERVAL_MS;
  const outerSignal = spec.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  // Loop forever (no timeout in Plan 1). Each iteration:
  //   1. fetch the URL with the outer signal wired up
  //   2. on 2xx → resolve
  //   3. otherwise (non-2xx OR network error) → sleep intervalMs then retry
  // Abort can fire at any point — both during fetch and during the sleep.
  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    try {
      const response = await fetch(spec.url, { signal: outerSignal });
      if (response.status >= 200 && response.status < 300) {
        // Drain the body so the underlying connection can be released.
        // Errors here are non-fatal; we already have the status.
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        return;
      }
      // Non-2xx — drain and keep polling.
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
    } catch (err) {
      // If the abort fired mid-fetch, surface it as "aborted".
      if (outerSignal?.aborted) {
        throw new Error("aborted");
      }
      // Otherwise it's a network error (ECONNREFUSED, DNS, etc.). Swallow
      // and fall through to the sleep + next attempt.
    }

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
