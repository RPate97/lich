// api.ts — wire types + fetch helpers for the lich dashboard SPA.
//
// The shape of `StackView` here is the JSON the v1 dashboard server returns
// from `/api/stacks` and `/api/stacks/:id`. Source of truth lives in
// `packages/lich/src/daemon/dashboard/stacks-view.ts`; this module duplicates
// the shape locally so the SPA stays decoupled from the daemon source tree
// (the UI builds independently via vite and would otherwise need bundler
// aliases to reach across the package). The duplication is small and the
// wire format is intentionally stable per the docstring on `StackView` in
// `stacks-view.ts` — if these two ever drift, the wire shape there wins.

// ---------------------------------------------------------------------------
// Wire types — mirror `stacks-view.ts`
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a single service. v1 expands the v0 4-value enum into
 * the seven states defined in `state/snapshot.ts`'s `ServiceState`.
 */
export type ServiceState =
  | 'starting'
  | 'healthy'
  | 'initializing'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

/**
 * Per-service detail. Mirrors `StackView["services"][number]` in
 * `stacks-view.ts`. `ports` and `failure_*` are omitted by the server when
 * empty, so they're optional here too.
 */
export interface ServiceView {
  name: string;
  kind: 'owned' | 'compose';
  state: ServiceState;
  failure_reason?: string;
  failure_log_tail?: string[];
  ports?: Record<string, number>;
}

/** Stack-level lifecycle status. Mirrors `StackStatus` in `state/snapshot.ts`. */
export type StackStatus =
  | 'starting'
  | 'up'
  | 'partial'
  | 'stopping'
  | 'stopped'
  | 'failed';

/**
 * Stack-level wire shape. Mirrors `StackView` in `stacks-view.ts` — keep this
 * in sync (or import from there if the build ever cross-compiles).
 */
export interface StackView {
  id: string;
  worktree_name: string;
  status: StackStatus;
  /** Profile this stack was started under, when one was declared. */
  active_profile?: string;
  services: ServiceView[];
  /**
   * Clickable URL for the stack (derived from the first routing entry's
   * `upstream_url` by the server). Omitted when the stack has no routing.
   */
  primary_url?: string;
  /** ISO 8601 timestamp. */
  started_at?: string;
}

/**
 * Result of a stack action (restart/stop). Matches the server's
 * `ActionResult` in `daemon/dashboard/actions.ts`.
 */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * One SSE frame from the log endpoints. The merged stream
 * (`/api/stacks/:id/logs`) always carries a `service`; the single-service
 * stream (`/api/stacks/:id/logs?service=<name>`) does too — the wire shape
 * is uniform.
 *
 * `ts` and `level` are absent from raw `.log` lines (the LogTail primitive
 * only emits text); the UI synthesizes display defaults when they're
 * missing.
 */
export interface LogEvent {
  service: string;
  line: string;
  ts?: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the current stack list. The v1 server returns the bare array (not
 * a `{ stacks: [...] }` wrapper — see `server.ts` `jsonResponse(cache)`).
 */
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

/** POST /api/stacks/:id/restart — returns the ActionResult from the CLI. */
export async function restartStack(id: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

/** POST /api/stacks/:id/stop — returns the ActionResult from the CLI. */
export async function stopStack(id: string): Promise<ActionResult> {
  const res = await fetch(`/api/stacks/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  return (await res.json()) as ActionResult;
}

/**
 * Subscribe to the merged multi-service log stream for a stack. The browser's
 * EventSource handles reconnect on its own; the returned unsubscribe closes
 * the connection.
 */
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
      // Malformed frame — ignore (the SSE comment heartbeat triggers this
      // on browsers that re-route comments through onmessage; harmless).
    }
  };
  return () => es.close();
}

/**
 * Subscribe to a single-service log stream. Same shape as
 * {@link openMergedLogStream} — kept as a separate helper because the URL
 * differs and so callers don't have to remember the query-string form.
 */
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
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}
