import { readDaemonUrl } from "./daemon.js";

export interface FetchDashboardJsonOpts {
  method?: "GET" | "POST";
  timeoutMs?: number;
}

/**
 * Fetch a JSON path off the daemon's dashboard server, parse as JSON.
 * Distinct errors for missing `daemon.url` vs HTTP non-2xx so failures are
 * one line in the output. Assumes `waitForDaemonRunning` already resolved.
 */
export async function fetchDashboardJson<T>(
  lichHome: string,
  path: string,
  opts: FetchDashboardJsonOpts = {},
): Promise<T> {
  const url = readDaemonUrl(lichHome);
  if (!url) {
    throw new Error(
      `No daemon.url in ${lichHome} — did you waitForDaemonRunning first?`,
    );
  }
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(new URL(path, url).toString(), {
      method,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${path}`);
  }
  return (await res.json()) as T;
}
