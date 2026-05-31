/**
 * Pure parser for `ps -A -o pid,ppid,rss,pcpu,time` output. macOS + Linux
 * compatible. RSS in KB; pcpu is "CPU% since start" (informational only — the
 * sampler diffs cumulative `time` across consecutive pairs to derive
 * instantaneous CPU%).
 *
 * `time` format: macOS prints `MM:SS.ff` or `HH:MM:SS`; Linux prints
 * `HH:MM:SS` or `D-HH:MM:SS` (with days). Both parsed here.
 */

import type { PsRow } from "./types.js";

/** Parse the multi-line output of `ps -A -o pid,ppid,rss,pcpu,time`. Header line discarded; malformed rows skipped. */
export function parsePsOutput(stdout: string): PsRow[] {
  const out: PsRow[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (i === 0 && /^PID\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss_kb = Number(parts[2]);
    const pcpu = Number(parts[3]);
    // Older callers (e.g. unit tests with the 4-column shape) omit `time`;
    // treat as 0 so the row still parses.
    const cpu_time_seconds = parts.length >= 5 ? parseCpuTime(parts[4]) : 0;
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      !Number.isFinite(rss_kb) ||
      !Number.isFinite(pcpu)
    ) {
      continue;
    }
    out.push({ pid, ppid, rss_kb, pcpu, cpu_time_seconds });
  }
  return out;
}

/**
 * Parse a `ps -o time` token to seconds.
 *
 * Formats handled:
 *   `1:23.45`      → 1m23.45s   (macOS short form)
 *   `12:34:56`     → 12h34m56s  (HH:MM:SS)
 *   `2-12:34:56`   → 2d12h34m56s (Linux days-hours form)
 *
 * Returns 0 on parse failure.
 */
export function parseCpuTime(token: string): number {
  if (!token || token.length === 0) return 0;
  let s = token;
  let days = 0;
  const dashIdx = s.indexOf("-");
  if (dashIdx > 0) {
    const d = Number(s.slice(0, dashIdx));
    if (Number.isFinite(d)) days = d;
    s = s.slice(dashIdx + 1);
  }
  const segs = s.split(":");
  if (segs.length === 2) {
    const m = Number(segs[0]);
    const sec = Number(segs[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
    return days * 86400 + m * 60 + sec;
  }
  if (segs.length === 3) {
    const h = Number(segs[0]);
    const m = Number(segs[1]);
    const sec = Number(segs[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) {
      return 0;
    }
    return days * 86400 + h * 3600 + m * 60 + sec;
  }
  return 0;
}
