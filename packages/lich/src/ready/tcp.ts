/**
 * tcp ready evaluator.
 *
 * Polls a TCP connect to `host:port` at a fixed interval; resolves when
 * the connection succeeds. Connection refused / DNS errors / per-attempt
 * timeouts all cause the loop to keep polling. Plan 1 has NO outer
 * timeout — callers wrap with a timeout in Plan 4.
 *
 * Each attempt uses a short per-attempt connect timeout so a hung
 * connection (e.g. firewalled host, accepted-but-never-handshakes peer)
 * doesn't block the polling loop.
 *
 * The supplied AbortSignal cancels both any in-flight socket and the
 * inter-attempt sleep; on abort the returned promise rejects with an
 * Error whose message contains "aborted".
 *
 * Malformed `target` strings reject IMMEDIATELY (no polling), since no
 * amount of retrying will fix a parse error.
 */

import { Socket } from "node:net";

export interface TcpReadySpec {
  /**
   * Target as `host:port`, e.g. `"localhost:5432"`. The caller (the
   * interpolation engine, later) substitutes `${owned.X.ports.Y}` and
   * friends into the target before passing it here.
   */
  target: string;
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
const MAX_PER_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * Returns a Promise that resolves when a TCP connection to `target`
 * succeeds. Rejects if the supplied AbortSignal fires, or if `target`
 * is malformed.
 */
export async function waitForTcpReady(spec: TcpReadySpec): Promise<void> {
  const { host, port } = parseTarget(spec.target);
  const intervalMs = spec.intervalMs ?? DEFAULT_INTERVAL_MS;
  const perAttemptTimeoutMs = Math.min(intervalMs, MAX_PER_ATTEMPT_TIMEOUT_MS);
  const outerSignal = spec.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  // Loop forever (no timeout in Plan 1). Each iteration:
  //   1. attempt a TCP connect with a short per-attempt timeout
  //   2. on connect → resolve
  //   3. otherwise (refused / timeout / dns error) → sleep intervalMs then retry
  // Abort can fire at any point — both during the connect and during the sleep.
  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    try {
      await tryConnect(host, port, perAttemptTimeoutMs, outerSignal);
      return;
    } catch (err) {
      // If the abort fired mid-connect, surface it as "aborted".
      if (outerSignal?.aborted) {
        throw new Error("aborted");
      }
      // Otherwise it's a connect error (ECONNREFUSED, ETIMEDOUT, DNS,
      // per-attempt timeout, etc.). Swallow and fall through to the
      // sleep + next attempt.
    }

    await sleep(intervalMs, outerSignal);
  }
}

/**
 * Parse a `host:port` target string. Throws synchronously (caller will
 * propagate as immediate rejection) when malformed — empty, missing
 * port, non-numeric port, or out-of-range port.
 */
function parseTarget(target: string): { host: string; port: number } {
  const malformed = () =>
    new Error(`invalid tcp target: ${target} (expected host:port)`);

  if (typeof target !== "string" || target.length === 0) {
    throw malformed();
  }

  // Split on the LAST colon so future IPv6 bracket forms could be added
  // without breaking the common host:port case. For now we require
  // exactly one colon's worth of host on the left and a numeric port on
  // the right.
  const idx = target.lastIndexOf(":");
  if (idx <= 0 || idx === target.length - 1) {
    throw malformed();
  }

  const host = target.slice(0, idx);
  const portStr = target.slice(idx + 1);

  if (!/^\d+$/.test(portStr)) {
    throw malformed();
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw malformed();
  }

  return { host, port };
}

/**
 * Attempt a single TCP connect with a per-attempt timeout. Resolves on
 * the `connect` event; rejects on `error`, `timeout`, or outer abort.
 * Always destroys the socket before settling.
 */
function tryConnect(
  host: string,
  port: number,
  perAttemptTimeoutMs: number,
  outerSignal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = new Socket();
    let settled = false;

    const cleanup = () => {
      sock.removeAllListeners();
      if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
      sock.destroy();
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onTimeout = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("timeout"));
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("aborted"));
    };

    sock.setTimeout(perAttemptTimeoutMs);
    sock.once("connect", onConnect);
    sock.once("error", onError);
    sock.once("timeout", onTimeout);

    if (outerSignal) {
      if (outerSignal.aborted) {
        onAbort();
        return;
      }
      outerSignal.addEventListener("abort", onAbort, { once: true });
    }

    sock.connect(port, host);
  });
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
