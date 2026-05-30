const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Humanize a byte count. Matches the `lich top` table style. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Render CPU% with a fixed one-decimal precision. */
export function formatCpuPct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

export type CpuLoad = 'idle' | 'low' | 'mid' | 'high';

/** Threshold buckets for CPU% color cues. <50% green, 50-80% yellow, >80% red.
 *  Zero stays neutral so a calm dashboard doesn't paint everything green. */
export function cpuLoad(pct: number): CpuLoad {
  if (!Number.isFinite(pct) || pct <= 0) return 'idle';
  if (pct < 50) return 'low';
  if (pct < 80) return 'mid';
  return 'high';
}

/** Limit-aware memory bucket. >85% of limit is high; >65% mid. Unbounded → idle. */
export function memLoad(used: number, limit?: number): CpuLoad {
  if (!Number.isFinite(used) || used <= 0) return 'idle';
  if (limit === undefined || limit <= 0) return 'idle';
  const ratio = used / limit;
  if (ratio < 0.65) return 'low';
  if (ratio < 0.85) return 'mid';
  return 'high';
}
