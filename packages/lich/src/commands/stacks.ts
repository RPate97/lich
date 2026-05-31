/**
 * `lich stacks [--json]` — list every stack with a `state.json` under LICH_HOME.
 * Read-only over the snapshot; no daemon, no IPC, no liveness probing.
 * Orphan dirs (no state.json) are silently skipped.
 */

import { listStacks } from "../state/directory.js";
import {
  readSnapshot,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../state/snapshot.js";
import { TartBackend } from "../sandbox/tart.js";
import type { SandboxState } from "../sandbox/backend.js";

export interface RunStacksInput {
  out?: NodeJS.WritableStream;
  json?: boolean;
  /** Injectable for tests; defaults to TartBackend. Reports sandbox VM state. */
  backend?: { inspect(name: string): Promise<SandboxState> };
}

export interface RunStacksResult {
  exitCode: number;
}

interface StackRow {
  stack_id: string;
  worktree_name: string;
  status: StackSnapshot["status"];
  started_at: string;
  uptime_seconds: number;
  services: Array<Pick<ServiceSnapshot, "name" | "kind" | "state">>;
  primary_url?: string;
  /** Omitted from JSON when the snapshot has no profile recorded. */
  active_profile?: string;
  /** Set only for sandboxed stacks. */
  sandbox?: boolean;
  sandbox_vm?: string;
  sandbox_state?: string;
  // Derived counts — kept off the JSON wire; tools compute from `services`.
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

  const snapshots: StackSnapshot[] = [];
  for (const id of ids) {
    const snap = await readSnapshot(id);
    if (snap !== null) snapshots.push(snap);
  }

  const now = Date.now();
  const rows = snapshots
    .map((snap) => snapshotToRow(snap, now))
    .sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));

  const sandboxRows = rows.filter((r) => r.sandbox && r.sandbox_vm);
  if (sandboxRows.length > 0) {
    const backend = input.backend ?? new TartBackend();
    for (const row of sandboxRows) {
      try {
        row.sandbox_state = (await backend.inspect(row.sandbox_vm!)).state;
      } catch {
        row.sandbox_state = "unknown";
      }
    }
  }

  if (json) {
    writeLine(out, renderJson(rows));
  } else {
    writeLine(out, renderPretty(rows));
  }

  return { exitCode: 0 };
}

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
    sandbox: snap.sandbox === true ? true : undefined,
    sandbox_vm: snap.sandbox === true ? snap.sandbox_vm : undefined,
    ready_count,
    total_count,
    failed_count,
  };
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
    // Omit (don't serialize null) so pre-profile snapshots stay clean.
    if (r.active_profile !== undefined) obj.active_profile = r.active_profile;
    if (r.sandbox) {
      obj.sandbox = true;
      if (r.sandbox_vm) obj.sandbox_vm = r.sandbox_vm;
      if (r.sandbox_state) obj.sandbox_state = r.sandbox_state;
    }
    return obj;
  });
  return JSON.stringify(payload, null, 2);
}

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
      r.sandbox && r.sandbox_vm
        ? `sandbox:${r.sandbox_vm}${r.sandbox_state ? ` (${r.sandbox_state})` : ""}`
        : (r.primary_url ?? ""),
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

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}
