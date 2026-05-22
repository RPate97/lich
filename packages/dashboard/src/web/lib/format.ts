import type { ServiceView } from '../../types';

/** Human relative duration from a millisecond span. Ported from data.jsx. */
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

/** Epoch-ms → HH:MM:SS clock. Ported from data.jsx. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface HealthSummary {
  up: number;
  down: number;
  total: number;
}

/** Count service liveness for a stack. */
export function summarizeHealth(services: ServiceView[]): HealthSummary {
  const up = services.filter((s) => s.status === 'up').length;
  return { up, down: services.length - up, total: services.length };
}

// Fixed palette — known service names get a stable hue; anything else falls
// back to a hash into the palette. Mirrors the prototype's SERVICE_DEFS colors.
const KNOWN: Record<string, string> = {
  postgres: '#60a5fa',
  redis: '#f87171',
  temporal: '#fbbf24',
  api: '#a78bfa',
  workers: '#4ade80',
  web: '#22d3ee',
};
const PALETTE = ['#a78bfa', '#4ade80', '#22d3ee', '#fbbf24', '#f87171', '#60a5fa'];

/** Stable display color for a service, keyed by name. */
export function serviceColor(name: string): string {
  const known = KNOWN[name];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
