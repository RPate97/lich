import type { StacksResponse, LogEvent, StackMetrics } from '../types';

/** Result of a stack action (restart/stop). Mirrors server's ActionResult. */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Fetch the current stack list from the dashboard server. */
export async function fetchStacks(): Promise<StacksResponse> {
  const res = await fetch('/api/stacks');
  if (!res.ok) throw new Error(`/api/stacks responded ${res.status}`);
  return (await res.json()) as StacksResponse;
}

/** Fetch live CPU + memory metrics for one stack, sampled on demand. */
export async function fetchStackMetrics(key: string): Promise<StackMetrics> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(key)}/metrics`);
  if (!res.ok) throw new Error(`/api/stacks/${key}/metrics responded ${res.status}`);
  return (await res.json()) as StackMetrics;
}

/** POST /api/stacks/:key/restart — returns the ActionResult from the CLI. */
export async function restartStack(key: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(key)}/restart`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

/** POST /api/stacks/:key/stop — returns the ActionResult from the CLI. */
export async function stopStack(key: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(key)}/stop`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

/**
 * Open a live log stream for one service. Returns an unsubscribe function that
 * closes the EventSource. `onEvent` fires once per log line.
 */
export function openLogStream(
  key: string,
  service: string,
  onEvent: (e: LogEvent) => void,
): () => void {
  const url = `/api/stacks/${encodeURIComponent(key)}/logs/${encodeURIComponent(service)}`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LogEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}

/**
 * Open the merged multi-service log stream for a stack. Each event carries a
 * `service` field. Returns an unsubscribe function that closes the EventSource.
 */
export function openMergedLogStream(
  key: string,
  onEvent: (e: LogEvent) => void,
): () => void {
  const url = `/api/stacks/${encodeURIComponent(key)}/logs`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LogEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}
