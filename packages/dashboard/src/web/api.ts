import type { StacksResponse, LogEvent } from '../types';

/** Fetch the current stack list from the dashboard server. */
export async function fetchStacks(): Promise<StacksResponse> {
  const res = await fetch('/api/stacks');
  if (!res.ok) throw new Error(`/api/stacks responded ${res.status}`);
  return (await res.json()) as StacksResponse;
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
