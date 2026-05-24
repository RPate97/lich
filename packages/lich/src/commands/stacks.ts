/**
 * `lich stacks` — list every stack running on this machine.
 *
 * Reads every `~/.lich/stacks/<id>/state.json` (or `$LICH_HOME/stacks/...`)
 * via `listStacks()` + `readSnapshot()` and renders a row per stack.
 *
 * Pretty output (default):
 *
 *   WORKTREE       STATUS    UPTIME    SERVICES   URL
 *   dogfood-stack  up        00:12:34  3/3        http://localhost:5847
 *   experiment-a   partial   00:01:02  1/3 (2 failed)
 *
 * `--json` output: a single JSON array of stack records — easier for tools
 * to consume than NDJSON for a single-shot list command.
 *
 * Empty state: `no stacks running` (pretty) or `[]` (json). Exit 0.
 *
 * Orphan directories (no `state.json`) are skipped silently — these are
 * common during crash recovery; the user cares about live stacks, not
 * leftover scaffolding.
 *
 * Sorted alphabetically by worktree name for deterministic display.
 *
 * Plan 1 scope: read-only over the snapshot. No daemon, no IPC, no
 * liveness probing — what's in `state.json` is what we report.
 */

import { listStacks } from "../state/directory.js";
import {
  readSnapshot,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../state/snapshot.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunStacksInput {
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** `--json` flag for machine-readable output. */
  json?: boolean;
}

export interface RunStacksResult {
  exitCode: number;
}

/**
 * One row in the rendered output / one object in the JSON array.
 * Computed from a `StackSnapshot` plus the current time.
 */
interface StackRow {
  stack_id: string;
  worktree_name: string;
  status: StackSnapshot["status"];
  started_at: string;
  uptime_seconds: number;
  services: Array<Pick<ServiceSnapshot, "name" | "kind" | "state">>;
  primary_url?: string;
  /**
   * Profile this stack was started under, surfaced verbatim from
   * `state.json`'s `active_profile`. Omitted (and absent from the JSON
   * output) when the snapshot has no profile recorded — e.g. a stack
   * brought up against a yaml with no `profiles` section, or a pre-Plan-3
   * snapshot. Plan 3 Task 19 (LEV-393) added this to the wire format so
   * e2e tests + the eventual dashboard can confirm which profile is live.
   */
  active_profile?: string;
  // Derived counts (kept off the JSON wire intentionally — tools can compute
  // them from `services`).
  ready_count: number;
  total_count: number;
  failed_count: number;
}

export async function runStacks(
  input: RunStacksInput,
): Promise<RunStacksResult> {
  const out = input.out ?? process.stdout;
  const json = Boolean(input.json);

  const ids = await listStacks();

  // Read every snapshot. Orphan dirs (no state.json) silently drop out.
  const snapshots: StackSnapshot[] = [];
  for (const id of ids) {
    const snap = await readSnapshot(id);
    if (snap !== null) snapshots.push(snap);
  }

  const now = Date.now();
  const rows = snapshots
    .map((snap) => snapshotToRow(snap, now))
    .sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));

  if (json) {
    writeLine(out, renderJson(rows));
  } else {
    writeLine(out, renderPretty(rows));
  }

  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Row computation
// ---------------------------------------------------------------------------

function snapshotToRow(snap: StackSnapshot, now: number): StackRow {
  const services = snap.services ?? [];
  const ready_count = services.filter((s) => isReadyState(s.state)).length;
  const failed_count = services.filter((s) => s.state === "failed").length;
  const total_count = services.length;

  return {
    stack_id: snap.stack_id,
    worktree_name: snap.worktree_name,
    status: snap.status,
    started_at: snap.started_at,
    uptime_seconds: computeUptimeSeconds(snap.started_at, now),
    services: services.map((s) => ({
      name: s.name,
      kind: s.kind,
      state: s.state,
    })),
    primary_url: pickPrimaryUrl(services),
    active_profile: snap.active_profile,
    ready_count,
    total_count,
    failed_count,
  };
}

/**
 * A service is "ready" (counts toward the X/Y display) when it has
 * successfully passed startup — i.e. `healthy` or `ready` per the
 * `ServiceState` union. `initializing` and `starting` don't count yet;
 * `failed`/`stopping`/`stopped` clearly don't.
 */
function isReadyState(state: ServiceSnapshot["state"]): boolean {
  return state === "healthy" || state === "ready";
}

function computeUptimeSeconds(startedAtIso: string, nowMs: number): number {
  const startMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startMs)) return 0;
  const diff = Math.floor((nowMs - startMs) / 1000);
  return diff < 0 ? 0 : diff;
}

/**
 * First service (in declaration order) that has at least one allocated
 * port. We take the first port in `Object.entries()` order — the snapshot
 * preserves insertion order from the allocator, so this is "the first
 * logical port".
 */
function pickPrimaryUrl(services: ServiceSnapshot[]): string | undefined {
  for (const svc of services) {
    const ports = svc.allocated_ports;
    if (!ports) continue;
    const entries = Object.entries(ports);
    if (entries.length === 0) continue;
    const [, port] = entries[0];
    return `http://localhost:${port}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Uptime formatting
// ---------------------------------------------------------------------------

/** `HH:MM:SS`, or `Nd HH:MM:SS` when ≥ 24h. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ---------------------------------------------------------------------------
// JSON rendering
// ---------------------------------------------------------------------------

function renderJson(rows: StackRow[]): string {
  const payload = rows.map((r) => {
    const obj: Record<string, unknown> = {
      stack_id: r.stack_id,
      worktree_name: r.worktree_name,
      status: r.status,
      started_at: r.started_at,
      uptime_seconds: r.uptime_seconds,
      services: r.services,
    };
    if (r.primary_url) obj.primary_url = r.primary_url;
    // Only emit `active_profile` when the snapshot recorded one — leaving the
    // field out (rather than serializing `null`) keeps the wire format stable
    // for pre-Plan-3 stacks and for configs without a `profiles` section.
    if (r.active_profile !== undefined) obj.active_profile = r.active_profile;
    return obj;
  });
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Pretty rendering
// ---------------------------------------------------------------------------

const HEADERS = ["WORKTREE", "STATUS", "UPTIME", "SERVICES", "URL"] as const;

function renderPretty(rows: StackRow[]): string {
  if (rows.length === 0) return "no stacks running";

  const cells: string[][] = [HEADERS.map((h) => h)];
  for (const r of rows) {
    cells.push([
      r.worktree_name,
      r.status,
      formatUptime(r.uptime_seconds),
      formatServiceCount(r),
      r.primary_url ?? "",
    ]);
  }

  // Column widths = max cell length per column.
  const widths = HEADERS.map((_, col) =>
    Math.max(...cells.map((row) => row[col].length)),
  );

  // Two-space gutter between columns. Don't pad the last column.
  const lines: string[] = [];
  for (const row of cells) {
    const parts: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const isLast = i === row.length - 1;
      parts.push(isLast ? row[i] : row[i].padEnd(widths[i]));
    }
    lines.push(parts.join("  ").trimEnd());
  }
  return lines.join("\n");
}

/** `3/3` healthy → `3/3`; `1/3` with 2 failed → `1/3 (2 failed)`. */
function formatServiceCount(r: StackRow): string {
  const base = `${r.ready_count}/${r.total_count}`;
  return r.failed_count > 0 ? `${base} (${r.failed_count} failed)` : base;
}

// ---------------------------------------------------------------------------
// Output sink helper
// ---------------------------------------------------------------------------

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}
