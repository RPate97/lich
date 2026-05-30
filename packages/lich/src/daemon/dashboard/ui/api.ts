// Wire types + fetch helpers for the dashboard SPA. Source of truth for the
// JSON shapes lives in `daemon/dashboard/stacks-view.ts`; duplicated here so
// the SPA builds independently via vite.

/** Lifecycle state of a single service. */
export type ServiceState =
  | 'starting'
  | 'healthy'
  | 'initializing'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** Per-service detail. */
export interface ServiceView {
  name: string;
  kind: 'owned' | 'compose';
  state: ServiceState;
  failure_reason?: string;
  failure_log_tail?: string[];
  ports?: Record<string, number>;
  /** Friendly URL via the daemon's reverse proxy; absent when no routing entry exists yet. */
  url?: string;
}

/** Stack-level lifecycle status. */
export type StackStatus =
  | 'starting'
  | 'up'
  | 'partial'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** Stack-level wire shape. */
export interface StackView {
  id: string;
  worktree_name: string;
  status: StackStatus;
  active_profile?: string;
  services: ServiceView[];
  /** First routing entry's friendly URL; omitted when the stack has no routing yet. */
  primary_url?: string;
  /** Reverse proxy port — lets clients render the apex `<worktree>.lich.localhost:<port>` URL. */
  proxy_port?: number;
  /** ISO 8601 timestamp. */
  started_at?: string;
}

/** Result of a stack action (restart/stop). */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * One SSE frame from the log endpoints. `ts` and `level` are absent from raw
 * `.log` lines; the UI synthesizes display defaults when missing.
 */
export interface LogEvent {
  service: string;
  line: string;
  ts?: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

/** Fetch the current stack list. */
export async function fetchStacks(): Promise<StackView[]> {
  const res = await fetch('/api/stacks');
  if (!res.ok) throw new Error(`/api/stacks responded ${res.status}`);
  return (await res.json()) as StackView[];
}

/** Fetch one stack's detail. 404 → null. */
export async function fetchStack(id: string): Promise<StackView | null> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/stacks/${id} responded ${res.status}`);
  return (await res.json()) as StackView;
}

export async function restartStack(id: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

export async function stopStack(id: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

/** Subscribe to the merged multi-service log stream. Returned function closes the connection. */
export function openMergedLogStream(
  stackId: string,
  onEvent: (e: LogEvent) => void,
): () => void {
  const url = `/api/stacks/${encodeURIComponent(stackId)}/logs`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LogEvent);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

/** Subscribe to a single-service log stream. */
export function openServiceLogStream(
  stackId: string,
  service: string,
  onEvent: (e: LogEvent) => void,
): () => void {
  const url = `/api/stacks/${encodeURIComponent(stackId)}/logs?service=${encodeURIComponent(service)}`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LogEvent);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

/** Per-service metrics frame from the daemon's sampler. */
export interface ServiceMetricsOwned {
  name: string;
  kind: 'owned';
  state: string;
  pid?: number;
  cpu_pct: number;
  mem_bytes: number;
  uptime_seconds: number;
  process_count: number;
}

export interface ServiceMetricsCompose {
  name: string;
  kind: 'compose';
  state: string;
  container_id?: string;
  cpu_pct: number;
  mem_bytes: number;
  mem_limit_bytes?: number;
  uptime_seconds: number;
}

export type ServiceMetrics = ServiceMetricsOwned | ServiceMetricsCompose;

/** Full per-stack metrics snapshot. Matches StackMetricsSnapshot in daemon/metrics/types.ts. */
export interface StackMetricsSnapshot {
  stack_id: string;
  sampled_at: string;
  total: { cpu_pct: number; mem_bytes: number };
  services: ServiceMetrics[];
}

/** Single process entry inside an owned service's tree. */
export interface ProcessTreeNode {
  pid: number;
  ppid: number;
  rss_bytes: number;
  cpu_pct_cumulative: number;
  children: ProcessTreeNode[];
}

/** Tree response for `/api/stacks/:id/services/:name/proc-tree`. */
export interface ProcessTreeResponse {
  service: string;
  pid: number;
  process_count: number;
  mem_bytes: number;
  cpu_pct_cumulative: number;
  tree: ProcessTreeNode | null;
}

/** One-shot snapshot. The endpoint always returns 200 with an empty payload during the sampler's warmup window. */
export async function fetchStackMetrics(
  stackId: string,
): Promise<StackMetricsSnapshot> {
  const res = await fetch(
    `/api/stacks/${encodeURIComponent(stackId)}/metrics`,
  );
  if (!res.ok) {
    throw new Error(`/api/stacks/${stackId}/metrics responded ${res.status}`);
  }
  return (await res.json()) as StackMetricsSnapshot;
}

/** SSE subscription to live metrics. Returns a closer. */
export function openMetricsStream(
  stackId: string,
  onSnap: (snap: StackMetricsSnapshot) => void,
  onError?: (err: Event) => void,
): () => void {
  const url = `/api/stacks/${encodeURIComponent(stackId)}/metrics/stream`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onSnap(JSON.parse(msg.data) as StackMetricsSnapshot);
    } catch {
      /* ignore */
    }
  };
  if (onError) es.onerror = onError;
  return () => es.close();
}

/** Fetch the process tree for one owned service. 404/409 → null. */
export async function fetchProcessTree(
  stackId: string,
  serviceName: string,
): Promise<ProcessTreeResponse | null> {
  const res = await fetch(
    `/api/stacks/${encodeURIComponent(stackId)}/services/${encodeURIComponent(serviceName)}/proc-tree`,
  );
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) {
    throw new Error(
      `/api/stacks/${stackId}/services/${serviceName}/proc-tree responded ${res.status}`,
    );
  }
  return (await res.json()) as ProcessTreeResponse;
}
