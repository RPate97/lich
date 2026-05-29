/**
 * tcp ready evaluator. Polls a TCP connect to `host:port`; resolves on success.
 * Connection refused / DNS / per-attempt timeouts keep polling. No outer
 * timeout — callers wrap with `withTimeout`. AbortSignal cancels both
 * in-flight socket and sleep. Malformed `target` rejects immediately.
 *
 * Each attempt uses a short per-attempt connect timeout so a hung connection
 * (firewalled host, accepted-but-never-handshakes peer) doesn't block the loop.
 */

import { Socket } from "node:net";

export interface TcpReadySpec {
  /** Target as `host:port`, e.g. `"localhost:5432"`. */
  target: string;
  /** Polling interval in ms. Default 250. */
  intervalMs?: number;
  /** AbortSignal to cancel the polling loop. On fire, the promise rejects. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 250;
const MAX_PER_ATTEMPT_TIMEOUT_MS = 1000;

/** Resolves when TCP connect to `target` succeeds. Rejects on abort or malformed target. */
export async function waitForTcpReady(spec: TcpReadySpec): Promise<void> {
  const { host, port } = parseTarget(spec.target);
  const intervalMs = spec.intervalMs ?? DEFAULT_INTERVAL_MS;
  const perAttemptTimeoutMs = Math.min(intervalMs, MAX_PER_ATTEMPT_TIMEOUT_MS);
  const outerSignal = spec.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    try {
      await tryConnect(host, port, perAttemptTimeoutMs, outerSignal);
      return;
    } catch (err) {
      if (outerSignal?.aborted) {
        throw new Error("aborted");
      }
      // Connect error (ECONNREFUSED, ETIMEDOUT, DNS, per-attempt timeout) — retry.
    }

    await sleep(intervalMs, outerSignal);
  }
}

function parseTarget(target: string): { host: string; port: number } {
  const malformed = () =>
    new Error(`invalid tcp target: ${target} (expected host:port)`);

  if (typeof target !== "string" || target.length === 0) {
    throw malformed();
  }

  // Split on the LAST colon so future IPv6 bracket forms can be added.
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
