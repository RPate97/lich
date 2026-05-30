/**
 * `lich top` — per-service CPU + memory live view. Polls the daemon's
 * /api/stacks/:id/metrics endpoint every `interval` seconds and renders a
 * table. Snapshot mode (--no-follow) prints once and exits. JSON mode emits
 * the daemon's response verbatim.
 *
 * Auto-starts the daemon (matches `lich top` being a debugging surface that
 * shouldn't fail just because nothing's been touched recently).
 *
 * Process-tree drill-in (--tree <service>) currently best-effort: the daemon
 * tracks the parent PID for owned services; the CLI walks the local ps
 * snapshot for the tree view (the daemon already does the heavy lifting in
 * its sampler, but exposing the per-PID breakdown wholesale would bloat the
 * /metrics endpoint).
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { ensureDaemonRunning } from "../daemon/auto-start.js";
import { readDaemonUrl } from "../daemon/pid-file.js";
import { resolveStackId } from "../state/resolve-stack.js";
import { readSnapshot } from "../state/snapshot.js";
import { listStacks } from "../state/directory.js";
import {
  parsePsOutput,
} from "../daemon/metrics/ps.js";
import {
  aggregateSubtree,
  buildTree,
  indexByPid,
  indexByPpid,
  type ProcessNode,
} from "../daemon/metrics/proc-tree.js";
import type {
  ServiceMetrics,
  StackMetricsSnapshot,
} from "../daemon/metrics/types.js";
import { formatUptime } from "./stacks.js";

const execFile = promisify(execFileCb);

export type SortKey = "cpu" | "mem" | "name";

export interface RunTopInput {
  cwd?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  /** --no-follow → print once and exit. Default false (follow). */
  noFollow?: boolean;
  /** --json → machine-readable, never refreshes (implies --no-follow). */
  json?: boolean;
  /** --all → every stack. Disables --worktree resolution. */
  all?: boolean;
  /** --tree <service> → expand process tree for one owned service. */
  tree?: string;
  /** --sort cpu|mem|name (default cpu). */
  sort?: SortKey;
  /** --interval N seconds (default 2). */
  interval?: number;
  /** Stack ID or worktree name (--worktree). */
  worktreeArg?: string;
  /** Test seam — abort the follow loop. */
  signal?: AbortSignal;
  /** Test seam for delays in follow mode. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunTopResult {
  exitCode: number;
}

const DEFAULT_INTERVAL_SECONDS = 2;

export async function runTop(input: RunTopInput = {}): Promise<RunTopResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const interval = Math.max(1, input.interval ?? DEFAULT_INTERVAL_SECONDS);
  const sort: SortKey = input.sort ?? "cpu";
  // --json implies --no-follow (machine-readable single shot).
  const follow = !input.noFollow && !input.json && input.tree === undefined;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  if (input.all && input.worktreeArg) {
    err.write("lich top: --all and --worktree are mutually exclusive\n");
    return { exitCode: 2 };
  }
  if (input.tree && input.all) {
    err.write("lich top: --tree and --all are mutually exclusive\n");
    return { exitCode: 2 };
  }

  let stackIds: string[];
  if (input.all) {
    stackIds = await listStacks();
    if (stackIds.length === 0) {
      err.write("no stacks found\n");
      return { exitCode: 1 };
    }
  } else {
    let stackId: string;
    try {
      const resolved = await resolveStackId({
        cwd,
        ...(input.worktreeArg !== undefined && { worktreeArg: input.worktreeArg }),
      });
      stackId = resolved.stackId;
    } catch (e) {
      if (input.worktreeArg) {
        err.write(`${(e as Error).message}\n`);
      } else {
        err.write("no stack found for this worktree (run lich up first)\n");
      }
      return { exitCode: 1 };
    }
    const snap = await readSnapshot(stackId).catch(() => null);
    if (!snap) {
      err.write(`lich top: no snapshot for stack '${stackId}'\n`);
      return { exitCode: 1 };
    }
    stackIds = [stackId];
  }

  try {
    await ensureDaemonRunning({ openBrowser: false, out });
  } catch (e) {
    err.write(`lich top: daemon failed to start: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  let daemonUrl: string | null;
  try {
    daemonUrl = await readDaemonUrl();
  } catch (e) {
    err.write(
      `lich top: failed to read daemon URL: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }
  if (daemonUrl === null) {
    err.write("lich top: daemon URL unavailable\n");
    return { exitCode: 1 };
  }
  const baseUrl = daemonUrl.replace(/\/$/, "");

  if (input.tree !== undefined) {
    return await runTreeMode({
      baseUrl,
      stackId: stackIds[0],
      service: input.tree,
      out,
      err,
    });
  }

  const render = async (): Promise<RunTopResult | null> => {
    const snapshots: StackMetricsSnapshot[] = [];
    const worktreeNames: Record<string, string> = {};
    for (const id of stackIds) {
      let snap: StackMetricsSnapshot;
      try {
        snap = await fetchMetrics(baseUrl, id);
      } catch (e) {
        err.write(`lich top: ${(e as Error).message}\n`);
        return { exitCode: 1 };
      }
      snapshots.push(snap);
      const localSnap = await readSnapshot(id).catch(() => null);
      if (localSnap) worktreeNames[id] = localSnap.worktree_name;
    }
    if (input.json) {
      const payload =
        input.all || stackIds.length > 1 ? snapshots : snapshots[0];
      out.write(JSON.stringify(payload, null, 2) + "\n");
      return { exitCode: 0 };
    }
    out.write(renderTable(snapshots, worktreeNames, { sort, showStackHeader: input.all === true }));
    return null;
  };

  if (!follow) {
    const result = await render();
    return result ?? { exitCode: 0 };
  }

  // Follow mode: clear screen each render, exit on signal abort.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  if (input.signal) {
    if (input.signal.aborted) aborted = true;
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (!aborted) {
      out.write("[2J[H"); // clear screen + cursor home
      const r = await render();
      if (r !== null) return r;
      // Sleep in small chunks so abort surfaces within ~100ms.
      const chunkMs = 100;
      let waited = 0;
      while (waited < interval * 1000 && !aborted) {
        await sleep(Math.min(chunkMs, interval * 1000 - waited));
        waited += chunkMs;
      }
    }
  } finally {
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
  }
  // newline so the prompt doesn't sit at column 0 of the last line.
  out.write("\n");
  return { exitCode: 0 };
}

async function fetchMetrics(
  baseUrl: string,
  stackId: string,
): Promise<StackMetricsSnapshot> {
  const url = `${baseUrl}/api/stacks/${stackId}/metrics`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`failed to fetch ${url}: ${(e as Error).message}`);
  }
  if (res.status === 503) {
    throw new Error(
      `daemon does not expose /api/stacks/:id/metrics (rebuild the daemon binary?)`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`GET ${url} returned ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(
      `failed to parse /api/stacks/${stackId}/metrics: ${(e as Error).message}`,
    );
  }
  return body as StackMetricsSnapshot;
}

interface RenderOpts {
  sort: SortKey;
  showStackHeader: boolean;
}

export function renderTable(
  snapshots: StackMetricsSnapshot[],
  worktreeNames: Record<string, string>,
  opts: RenderOpts,
): string {
  if (snapshots.length === 0) return "no stacks\n";

  const lines: string[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (opts.showStackHeader) {
      if (i > 0) lines.push("");
      const label = worktreeNames[snap.stack_id] ?? snap.stack_id;
      lines.push(`stack: ${label}`);
    }
    lines.push(...renderSingleStackTable(snap, opts.sort));
  }
  return lines.join("\n") + "\n";
}

const HEADERS = [
  "SERVICE",
  "PID",
  "STATE",
  "CPU%",
  "MEM",
  "UPTIME",
  "INFO",
] as const;

function renderSingleStackTable(
  snap: StackMetricsSnapshot,
  sort: SortKey,
): string[] {
  const sorted = sortServices(snap.services, sort);

  const rows: string[][] = [HEADERS.map((h) => h)];
  for (const svc of sorted) {
    rows.push([
      svc.name,
      formatPid(svc),
      svc.state,
      formatCpuPct(svc.cpu_pct),
      formatBytes(svc.mem_bytes),
      formatUptime(svc.uptime_seconds),
      formatInfo(svc),
    ]);
  }
  const totalLine = [
    "TOTAL",
    "",
    "",
    formatCpuPct(snap.total.cpu_pct),
    formatBytes(snap.total.mem_bytes),
    "",
    `${snap.services.length} services`,
  ];
  rows.push(totalLine);

  const widths = HEADERS.map((_, col) =>
    Math.max(...rows.map((row) => (row[col] ?? "").length)),
  );

  const out: string[] = [];
  for (const row of rows) {
    const parts: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const isLast = i === row.length - 1;
      parts.push(isLast ? row[i] : (row[i] ?? "").padEnd(widths[i]));
    }
    out.push(parts.join("  ").trimEnd());
  }
  return out;
}

function sortServices(services: ServiceMetrics[], by: SortKey): ServiceMetrics[] {
  const copy = [...services];
  switch (by) {
    case "cpu":
      copy.sort((a, b) => b.cpu_pct - a.cpu_pct);
      break;
    case "mem":
      copy.sort((a, b) => b.mem_bytes - a.mem_bytes);
      break;
    case "name":
      copy.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return copy;
}

function formatPid(svc: ServiceMetrics): string {
  if (svc.kind === "compose") return "—";
  return svc.pid !== undefined ? String(svc.pid) : "—";
}

function formatInfo(svc: ServiceMetrics): string {
  if (svc.kind === "compose") return "(container)";
  if (svc.process_count > 0) {
    return svc.process_count === 1
      ? "(1 proc)"
      : `(${svc.process_count} procs)`;
  }
  return "—";
}

export function formatCpuPct(n: number): string {
  if (!Number.isFinite(n)) return "0.0%";
  return `${n.toFixed(1)}%`;
}

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}

interface RunTreeArgs {
  baseUrl: string;
  stackId: string;
  service: string;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

async function runTreeMode(args: RunTreeArgs): Promise<RunTopResult> {
  let snap: StackMetricsSnapshot;
  try {
    snap = await fetchMetrics(args.baseUrl, args.stackId);
  } catch (e) {
    args.err.write(`lich top: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }
  const svc = snap.services.find((s) => s.name === args.service);
  if (!svc) {
    args.err.write(
      `lich top: service '${args.service}' not found in stack '${args.stackId}'\n`,
    );
    return { exitCode: 1 };
  }
  if (svc.kind !== "owned") {
    args.err.write(
      `lich top --tree: '${args.service}' is a compose service (no process tree to expand; see \`docker stats\`)\n`,
    );
    return { exitCode: 2 };
  }
  if (svc.pid === undefined) {
    args.err.write(
      `lich top --tree: '${args.service}' has no recorded PID (service may not be running)\n`,
    );
    return { exitCode: 1 };
  }

  let psOut: string;
  try {
    const { stdout } = await execFile(
      "ps",
      ["-A", "-o", "pid,ppid,rss,pcpu"],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    );
    psOut = stdout;
  } catch (e) {
    args.err.write(`lich top --tree: ps failed: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }
  const rows = parsePsOutput(psOut);
  const byPid = indexByPid(rows);
  const byPpid = indexByPpid(rows);
  const tree = buildTree(svc.pid, byPid, byPpid);
  if (!tree) {
    args.err.write(
      `lich top --tree: PID ${svc.pid} not present in ps snapshot (process may have exited)\n`,
    );
    return { exitCode: 1 };
  }
  const agg = aggregateSubtree(svc.pid, byPid, byPpid);

  args.out.write(
    `service: ${svc.name} (pid ${svc.pid}) — ${agg.process_count} procs, ${formatBytes(agg.mem_bytes)}, ${formatCpuPct(agg.cpu_pct_cumulative)} cumulative\n\n`,
  );
  args.out.write(renderTreeNode(tree, ""));
  return { exitCode: 0 };
}

export function renderTreeNode(node: ProcessNode, indent: string): string {
  const lines: string[] = [];
  const mem = formatBytes(node.rss_kb * 1024);
  lines.push(
    `${indent}- pid ${node.pid}  ${formatCpuPct(node.pcpu)} cumul  ${mem}`,
  );
  const childIndent = indent + "   ";
  for (const child of node.children) {
    lines.push(renderTreeNode(child, childIndent).replace(/\n+$/, ""));
  }
  return lines.join("\n") + "\n";
}
