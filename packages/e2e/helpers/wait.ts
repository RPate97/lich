import { createConnection } from "node:net";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_INTERVAL = 250;

/**
 * Polls an HTTP URL until 2xx or times out. Uses one outer deadline, no
 * per-request abort — per-request aborts thrash servers that compile on first
 * request (Next.js dev) by cancelling each compile mid-flight.
 */
export async function waitForHttp200(
  url: string,
  opts: WaitOptions = {}
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;
  const outerSignal = AbortSignal.timeout(timeout);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: outerSignal });
      if (res.status >= 200 && res.status < 300) return;
    } catch {
      // ignore; will retry until outer deadline
    }
    await sleep(interval);
  }

  throw new Error(`timeout waiting for HTTP 200 from ${url} after ${timeout}ms`);
}

/** Polls a TCP host:port until a connection succeeds, or times out. */
export async function waitForTcpOpen(
  host: string,
  port: number,
  opts: WaitOptions = {}
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const ok = await tryConnect(host, port);
    if (ok) return;
    await sleep(interval);
  }

  throw new Error(
    `timeout waiting for TCP ${host}:${port} after ${timeout}ms`
  );
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
