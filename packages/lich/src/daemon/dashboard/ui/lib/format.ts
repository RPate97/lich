// format.ts — small helpers for the dashboard UI.
//
// Ported from the v0 dashboard (`packages/dashboard/src/web/lib/format.ts`)
// but rewritten around the v1 `ServiceState` union and `StackView` wire shape
// from `packages/lich/src/daemon/dashboard/stacks-view.ts`.

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

/**
 * → HH:MM:SS clock. Accepts an epoch-ms number or an ISO-8601 string.
 * `new Date()` parses both forms natively.
 */
export function fmtClock(ts: number | string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface HealthSummary {
  /** Services that have successfully started (`healthy` or `ready`). */
  ready: number;
  /** Services in the `failed` state. */
  failed: number;
  /** All services. */
  total: number;
}

/**
 * Tally a stack's services for the sidebar/header health pill.
 *
 * Matches `commands/stacks.ts`'s `isReadyState`: `healthy` and `ready` count
 * toward "ready"; everything else (`starting`, `initializing`, `stopping`,
 * `stopped`, `failed`) does not. `failed` is broken out separately so the
 * caller can render "1/3 (2 failed)" style strings.
 */
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

// Fixed palette — known service names get a stable hue; anything else falls
// back to a hash into the palette. Desaturated so the dashboard is calm to
// read; each service is distinguishable but nothing screams.
const KNOWN: Record<string, string> = {
  postgres: '#7a95c8',  // dusty blue
  redis: '#c87a7a',     // dusty rose
  temporal: '#c8a868',  // muted ochre
  api: '#8b7ec8',       // muted lilac (matches brand purple)
  workers: '#6b9e7a',   // sage (matches brand green)
  web: '#7eb0b8',       // dusty cyan
  supabase: '#6b9e7a',  // sage (alias for `workers` hue)
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

/**
 * Aggregate every service's `ports` map into a single { name -> port }. The
 * sidebar uses the compact range form for the secondary line; the main pane
 * uses the full map.
 */
export function collectPorts(stack: StackView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const svc of stack.services) {
    if (!svc.ports) continue;
    for (const [name, port] of Object.entries(svc.ports)) {
      // If two services happen to expose the same logical port name we keep
      // the first — the UI rarely cares which since clashes shouldn't
      // happen in practice (allocator gives each service unique ports).
      if (!(name in out)) out[name] = port;
    }
  }
  return out;
}

/**
 * Compact port-range string for a stack. Returns the single port when there
 * is one, `min-max` for several, and `—` when there are none.
 */
export function formatPortRange(stack: StackView): string {
  const nums = Object.values(collectPorts(stack));
  if (nums.length === 0) return '—';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? String(min) : `${min}-${max}`;
}

/**
 * Map a v1 `ServiceState` to one of the three "health buckets" the sidebar
 * pill / status-row coloring uses:
 *   - `ok`      — `healthy` / `ready`
 *   - `pending` — `starting` / `initializing` / `stopping`
 *   - `bad`     — `failed`
 *   - `idle`    — `stopped`
 */
export type StateBucket = 'ok' | 'pending' | 'bad' | 'idle';

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

/**
 * Health bucket for the stack as a whole. Anything failed → unhealthy; all
 * services ok → healthy; otherwise → degraded.
 */
export function stackHealthBucket(stack: StackView): 'healthy' | 'degraded' | 'unhealthy' {
  const { ready, failed, total } = summarizeHealth(stack.services);
  if (failed > 0) return 'unhealthy';
  if (ready === total && total > 0) return 'healthy';
  return 'degraded';
}
