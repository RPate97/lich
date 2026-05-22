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
  urls: Record<string, string>;
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
}
