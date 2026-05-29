import type { ServiceView, StackView } from '../api';

/** Human relative duration from a millisecond span. */
export function fmtRelative(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** HH:MM:SS clock from epoch-ms or ISO-8601. */
export function fmtClock(ts: number | string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface HealthSummary {
  ready: number;
  failed: number;
  total: number;
}

/** Tally services for the health pill. `healthy`/`ready` count as ready. */
export function summarizeHealth(services: ServiceView[]): HealthSummary {
  const ready = services.filter(
    (s) => s.state === 'healthy' || s.state === 'ready',
  ).length;
  const failed = services.filter((s) => s.state === 'failed').length;
  return { ready, failed, total: services.length };
}

/** "ready/total" — or "ready/total (N failed)" when any service has failed. */
export function formatHealthCount(stack: StackView): string {
  const { ready, failed, total } = summarizeHealth(stack.services);
  const base = `${ready}/${total}`;
  return failed > 0 ? `${base} (${failed} failed)` : base;
}

// Known service names get a stable hue; unknown names hash into PALETTE
const KNOWN: Record<string, string> = {
  postgres: '#7a95c8',
  redis: '#c87a7a',
  temporal: '#c8a868',
  api: '#8b7ec8',
  workers: '#6b9e7a',
  web: '#7eb0b8',
  supabase: '#6b9e7a',
};
const PALETTE = ['#8b7ec8', '#6b9e7a', '#7eb0b8', '#c8a868', '#c87a7a', '#7a95c8'];

/** Stable display color for a service, keyed by name. */
export function serviceColor(name: string): string {
  const known = KNOWN[name];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Flatten every service's `ports` into { name -> port }. First wins on name collision. */
export function collectPorts(stack: StackView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const svc of stack.services) {
    if (!svc.ports) continue;
    for (const [name, port] of Object.entries(svc.ports)) {
      if (!(name in out)) out[name] = port;
    }
  }
  return out;
}

/** Port-range string: single port, `min-max`, or `—`. */
export function formatPortRange(stack: StackView): string {
  const nums = Object.values(collectPorts(stack));
  if (nums.length === 0) return '—';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? String(min) : `${min}-${max}`;
}

export type StateBucket = 'ok' | 'pending' | 'bad' | 'idle';

/** Coarse health bucket for status-row coloring. */
export function stateBucket(state: string): StateBucket {
  switch (state) {
    case 'healthy':
    case 'ready':
      return 'ok';
    case 'starting':
    case 'initializing':
    case 'stopping':
      return 'pending';
    case 'failed':
      return 'bad';
    case 'stopped':
      return 'idle';
    default:
      return 'pending';
  }
}

/** Stack-level health: any failed → unhealthy; all ok → healthy; else degraded. */
export function stackHealthBucket(stack: StackView): 'healthy' | 'degraded' | 'unhealthy' {
  const { ready, failed, total } = summarizeHealth(stack.services);
  if (failed > 0) return 'unhealthy';
  if (ready === total && total > 0) return 'healthy';
  return 'degraded';
}

export type ServiceStatus = 'healthy' | 'unhealthy' | 'starting' | 'idle';

/** Visual bucket for the services strip's dot color. */
export function serviceStatus(state: string): ServiceStatus {
  switch (state) {
    case 'healthy':
    case 'ready':
      return 'healthy';
    case 'failed':
      return 'unhealthy';
    case 'starting':
    case 'initializing':
    case 'stopping':
      return 'starting';
    default:
      return 'idle';
  }
}

/** First declared port from `lich.yaml` (insertion-order iteration). */
export function primaryPort(service: { ports?: Record<string, number> }): number | null {
  if (!service.ports) return null;
  const vals = Object.values(service.ports);
  return vals[0] ?? null;
}
