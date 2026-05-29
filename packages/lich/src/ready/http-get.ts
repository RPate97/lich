/**
 * http_get ready evaluator. Polls a URL at a fixed interval; resolves on 2xx.
 * Network errors / 4xx / 5xx keep polling. No outer timeout — callers wrap
 * with `withTimeout`. AbortSignal cancels both in-flight fetch and sleep.
 */

export interface HttpGetReadySpec {
  /** Full URL to poll, e.g. `http://localhost:5847/health`. */
  url: string;
  /** Polling interval in ms. Default 250. */
  intervalMs?: number;
  /** AbortSignal to cancel the polling loop. On fire, the promise rejects. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 250;

/** Resolves when `GET <url>` returns 2xx. Rejects on AbortSignal fire. */
export async function waitForHttpReady(spec: HttpGetReadySpec): Promise<void> {
  const intervalMs = spec.intervalMs ?? DEFAULT_INTERVAL_MS;
  const outerSignal = spec.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    try {
      const response = await fetch(spec.url, { signal: outerSignal });
      if (response.status >= 200 && response.status < 300) {
        // Drain so the connection can be released.
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        return;
      }
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
    } catch (err) {
      if (outerSignal?.aborted) {
        throw new Error("aborted");
      }
      // Otherwise it's a network error (ECONNREFUSED, DNS, etc.) — retry.
    }

    await sleep(intervalMs, outerSignal);
  }
}

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
