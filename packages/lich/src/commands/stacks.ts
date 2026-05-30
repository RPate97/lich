/**
 * `lich stacks [--json]` — list every stack with a `state.json` under LICH_HOME.
 * Read-only over the snapshot; no daemon, no IPC, no liveness probing.
 * Orphan dirs (no state.json) are silently skipped.
 */

import { listStacks } from "../state/directory.js";
import {
  readSnapshot,
  type LifecyclePhaseStatus,
  type LifecycleSnapshotStatus,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../state/snapshot.js";

export interface RunStacksInput {
  out?: NodeJS.WritableStream;
  json?: boolean;
}

export interface RunStacksResult {
  exitCode: number;
}

export interface StackRow {
  stack_id: string;
  worktree_name: string;
  status: StackSnapshot["status"];
  started_at: string;
  uptime_seconds: number;
  services: Array<Pick<ServiceSnapshot, "name" | "kind" | "state">>;
  primary_url?: string;
  /** Omitted from JSON when the snapshot has no profile recorded. */
  active_profile?: string;
  /** Per-phase lifecycle status from the snapshot, or undefined on pre-LEV-531 snapshots. */
  lifecycle?: LifecycleSnapshotStatus;
  // Derived counts — kept off the JSON wire; tools compute from `services`.
  ready_count: number;
  total_count: number;
  failed_count: number;
}

const LIFECYCLE_PHASE_ORDER = [
  "before_up",
  "after_up",
  "before_down",
  "after_down",
] as const;

export async function runStacks(
  input: RunStacksInput,
): Promise<RunStacksResult> {
  const out = input.out ?? process.stdout;
  const json = Boolean(input.json);

  const ids = await listStacks();

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

export function snapshotToRow(snap: StackSnapshot, now: number): StackRow {
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
    lifecycle: snap.lifecycle,
    ready_count,
    total_count,
    failed_count,
  };
}

/** First phase (in standard order) whose status is "failed", or null. */
function findFailedPhase(
  lifecycle: LifecycleSnapshotStatus | undefined,
): { phase: (typeof LIFECYCLE_PHASE_ORDER)[number]; entry: Extract<LifecyclePhaseStatus, { status: "failed" }> } | null {
  if (!lifecycle) return null;
  for (const phase of LIFECYCLE_PHASE_ORDER) {
    const entry = lifecycle[phase];
    if (entry?.status === "failed") {
      return { phase, entry };
    }
  }
  return null;
}

/** True for `healthy` or `ready` — what counts toward the X/Y display. */
function isReadyState(state: ServiceSnapshot["state"]): boolean {
  return state === "healthy" || state === "ready";
}

function computeUptimeSeconds(startedAtIso: string, nowMs: number): number {
  const startMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startMs)) return 0;
  const diff = Math.floor((nowMs - startMs) / 1000);
  return diff < 0 ? 0 : diff;
}

/** First service (declaration order) with an allocated port. */
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

export function renderJson(rows: StackRow[]): string {
  const payload = rows.map((r) => {
    const obj: Record<string, unknown> = {
      stack_id: r.stack_id,
      worktree_name: r.worktree_name,
      status: r.status,
    };
    // Surface lifecycle BEFORE services so a quick scan lands on the failure cause.
    if (r.lifecycle !== undefined) obj.lifecycle = r.lifecycle;
    obj.started_at = r.started_at;
    obj.uptime_seconds = r.uptime_seconds;
    obj.services = r.services;
    if (r.primary_url) obj.primary_url = r.primary_url;
    // Omit (don't serialize null) so pre-profile snapshots stay clean.
    if (r.active_profile !== undefined) obj.active_profile = r.active_profile;
    return obj;
  });
  return JSON.stringify(payload, null, 2);
}

const HEADERS = ["WORKTREE", "STATUS", "UPTIME", "SERVICES", "URL"] as const;

export function renderPretty(rows: StackRow[]): string {
  if (rows.length === 0) return "no stacks running";

  const cells: string[][] = [HEADERS.map((h) => h)];
  for (const r of rows) {
    cells.push([
      r.worktree_name,
      formatStatus(r),
      formatUptime(r.uptime_seconds),
      formatServiceCount(r),
      r.primary_url ?? "",
    ]);
  }

  const widths = HEADERS.map((_, col) =>
    Math.max(...cells.map((row) => row[col].length)),
  );

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

/** Stack status with a failed-phase suffix when a lifecycle hook caused the failure, e.g. `failed (after_up 2/3: db-reset)`. */
function formatStatus(r: StackRow): string {
  if (r.status !== "failed") return r.status;
  const failed = findFailedPhase(r.lifecycle);
  if (!failed) return r.status;
  return `${r.status} (${failed.phase} ${failed.entry.failed_index + 1}/${failed.entry.total}: ${failed.entry.failed_cmd})`;
}

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}
