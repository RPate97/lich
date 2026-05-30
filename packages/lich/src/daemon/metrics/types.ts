/**
 * Wire shapes for /api/stacks/<id>/metrics + the in-memory ring buffer.
 * Kept structurally identical to the JSON contract documented in LEV-538.
 */

export interface ServiceMetricsOwned {
  name: string;
  kind: "owned";
  state: string;
  pid?: number;
  cpu_pct: number;
  mem_bytes: number;
  uptime_seconds: number;
  process_count: number;
}

export interface ServiceMetricsCompose {
  name: string;
  kind: "compose";
  state: string;
  container_id?: string;
  cpu_pct: number;
  mem_bytes: number;
  mem_limit_bytes?: number;
  uptime_seconds: number;
}

export type ServiceMetrics = ServiceMetricsOwned | ServiceMetricsCompose;

export interface StackMetricsSnapshot {
  stack_id: string;
  sampled_at: string;
  total: { cpu_pct: number; mem_bytes: number };
  services: ServiceMetrics[];
}

/** Single process entry from `ps -A -o pid,ppid,rss,pcpu,time`. RSS is in KB; pcpu is OS "average since start" %; cpu_time_seconds is cumulative CPU time (sampler diffs this across pairs to derive instantaneous %). */
export interface PsRow {
  pid: number;
  ppid: number;
  rss_kb: number;
  pcpu: number;
  cpu_time_seconds: number;
}
