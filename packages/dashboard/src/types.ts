/** Status of a single service within a stack. */
export type ServiceStatus = 'up' | 'down';

/** A service line as the dashboard API reports it. */
export interface ServiceView {
  name: string;
  kind: 'owned' | 'compose';
  status: ServiceStatus;
  /** Present when the service exposes a UI. */
  url?: string;
}

/** Derived overall status of a stack. */
export type StackStatus = 'running' | 'partial' | 'down';

/** A stack as the dashboard API reports it. */
export interface StackView {
  key: string;
  path: string;
  branch: string;
  createdAt: string;
  status: StackStatus;
  /** True when `path` no longer exists on disk. */
  worktreeMissing: boolean;
  services: ServiceView[];
  /** Allocated ports for the stack, keyed by port name. */
  ports: Record<string, number>;
  urls: Record<string, string>;
  /** Agent that started this stack; undefined = manual (LEV-241). */
  startedBy?: string;
}

/** Response shape of `GET /api/stacks`. */
export interface StacksResponse {
  stacks: StackView[];
}

/** A single live-log line pushed over SSE. */
export interface LogEvent {
  line: string;
  ts?: string;
  level?: 'info' | 'error';
  stream?: 'stdout' | 'stderr';
  /** Present in events from the merged multi-service endpoint (LEV-244). */
  service?: string;
}

/** Per-stack CPU + memory metrics sampled on demand (LEV-242). */
export interface StackMetrics {
  /** Aggregate %CPU across the stack's processes + containers, 0–100*N (N cores). */
  cpuPct?: number;
  /** Aggregate resident memory in MB. */
  memMB?: number;
}

/** A log line as the Logs UI holds it — a LogEvent plus a render key + service. */
export interface LogLine {
  id: string;
  service: string;
  line: string;
  ts?: string;
  level: 'info' | 'error' | 'debug' | 'warn';
}
