/**
 * Parse `docker stats --no-stream --format json --no-trunc` output for the
 * stack's compose project. `docker stats` reports cgroup memory which already
 * aggregates all processes in a container — no tree walk needed (unlike
 * owned services).
 *
 * Output format (one JSON object per container, line-separated):
 *   {"BlockIO":"0B / 0B","CPUPerc":"0.50%","Container":"abc123","ID":"abc123",
 *    "MemPerc":"0.15%","MemUsage":"15.3MiB / 8GiB","Name":"...","NetIO":"...",
 *    "PIDs":"5"}
 *
 * MemUsage parsing: "15.3MiB / 8GiB" → { used: 15.3*1024^2, limit: 8*1024^3 }.
 */

export interface DockerStatRow {
  container_id: string;
  name: string;
  cpu_pct: number;
  mem_bytes: number;
  mem_limit_bytes?: number;
}

/** Parse the JSON-per-line output from `docker stats --no-stream --format json`. */
export function parseDockerStats(stdout: string): DockerStatRow[] {
  const out: DockerStatRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = strOrEmpty(obj.ID ?? obj.Container);
    const name = strOrEmpty(obj.Name);
    if (id.length === 0) continue;
    const cpu = parsePercent(strOrEmpty(obj.CPUPerc));
    const mem = parseMemUsage(strOrEmpty(obj.MemUsage));
    const row: DockerStatRow = {
      container_id: id,
      name,
      cpu_pct: cpu,
      mem_bytes: mem.used,
    };
    if (mem.limit !== undefined) {
      row.mem_limit_bytes = mem.limit;
    }
    out.push(row);
  }
  return out;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "12.34%" → 12.34. Returns 0 on parse failure (matches the "no measurement yet" semantics ps uses). */
export function parsePercent(s: string): number {
  const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** Parse a single "15.3MiB" / "8GiB" / "1.2GB" token to bytes. */
export function parseSizeToBytes(token: string): number | undefined {
  const m = token.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "B").toUpperCase();
  const factor = UNIT_BYTES[unit];
  if (factor === undefined) return undefined;
  return Math.round(n * factor);
}

/** "15.3MiB / 8GiB" → { used, limit }. Both fields tolerant of malformed sides. */
export function parseMemUsage(s: string): { used: number; limit?: number } {
  if (s.length === 0) return { used: 0 };
  const parts = s.split("/").map((p) => p.trim());
  const used = parseSizeToBytes(parts[0] ?? "") ?? 0;
  if (parts.length < 2) return { used };
  const limit = parseSizeToBytes(parts[1] ?? "");
  if (limit !== undefined) return { used, limit };
  return { used };
}
