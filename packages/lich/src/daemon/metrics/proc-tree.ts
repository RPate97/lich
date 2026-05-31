/**
 * Process-tree aggregation over a `ps` snapshot. Owned services in state.json
 * track a single parent PID, but real dev servers (next dev, pnpm dev, vite)
 * fork workers/subshells — single-PID sampling under-reports memory 5-10x.
 *
 * Strategy: index by ppid → children once, then BFS from each root PID.
 * Returns the matching subtree PIDs (root inclusive). Aggregation uses ps's
 * `rss` (KB) and `pcpu` (CPU% since start) so the caller can sum them.
 *
 * `pcpu` is OS-defined as "average CPU since process start", NOT current.
 * The sampler corrects this by diffing cumulative CPU time across two samples
 * 2s apart — the first sample of any process shows 0%, subsequent samples
 * are real "last 2s" CPU%.
 */

import type { PsRow } from "./types.js";

export interface TreeAggregate {
  /** Sum of RSS across the subtree, in bytes. */
  mem_bytes: number;
  /** Sum of pcpu across the subtree — "average since start" semantics. Informational. */
  cpu_pct_cumulative: number;
  /** Sum of cumulative CPU time (seconds) across the subtree. Sampler diffs this across pairs to derive instantaneous %. */
  cpu_time_seconds: number;
  /** Number of processes including the root. Zero when root isn't running. */
  process_count: number;
  /** PIDs in the subtree (root inclusive), useful for tree drill-in (`top --tree`). */
  pids: number[];
}

/** Build the children-by-ppid index in a single pass so a service tree walk is O(tree-size). */
export function indexByPpid(rows: PsRow[]): Map<number, PsRow[]> {
  const out = new Map<number, PsRow[]>();
  for (const row of rows) {
    const existing = out.get(row.ppid);
    if (existing) {
      existing.push(row);
    } else {
      out.set(row.ppid, [row]);
    }
  }
  return out;
}

/** Build a pid→row lookup so the BFS can resolve root PIDs in O(1). */
export function indexByPid(rows: PsRow[]): Map<number, PsRow> {
  const out = new Map<number, PsRow>();
  for (const row of rows) {
    out.set(row.pid, row);
  }
  return out;
}

/**
 * Walk the subtree rooted at `rootPid`, summing RSS + pcpu. When the root
 * isn't in the snapshot (process exited between state.json write and the ps
 * sample), returns zeros so the API surfaces "service down" rather than
 * crashing. Cycle-guard via a visited set — defensive; ps shouldn't cycle.
 */
export function aggregateSubtree(
  rootPid: number,
  byPid: Map<number, PsRow>,
  byPpid: Map<number, PsRow[]>,
): TreeAggregate {
  const root = byPid.get(rootPid);
  if (!root) {
    return {
      mem_bytes: 0,
      cpu_pct_cumulative: 0,
      cpu_time_seconds: 0,
      process_count: 0,
      pids: [],
    };
  }

  const pids: number[] = [];
  const visited = new Set<number>();
  let memKb = 0;
  let cpu = 0;
  let cpuTime = 0;

  const queue: PsRow[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.pid)) continue;
    visited.add(node.pid);
    pids.push(node.pid);
    memKb += node.rss_kb;
    cpu += node.pcpu;
    cpuTime += node.cpu_time_seconds;
    const children = byPpid.get(node.pid);
    if (!children) continue;
    for (const child of children) {
      if (!visited.has(child.pid)) queue.push(child);
    }
  }

  return {
    mem_bytes: memKb * 1024,
    cpu_pct_cumulative: cpu,
    cpu_time_seconds: cpuTime,
    process_count: pids.length,
    pids,
  };
}

export interface ProcessNode {
  pid: number;
  ppid: number;
  rss_kb: number;
  pcpu: number;
  children: ProcessNode[];
}

/** Build a node-with-children tree rooted at `rootPid`. Returns null when the root isn't in the snapshot. */
export function buildTree(
  rootPid: number,
  byPid: Map<number, PsRow>,
  byPpid: Map<number, PsRow[]>,
): ProcessNode | null {
  const root = byPid.get(rootPid);
  if (!root) return null;

  const visited = new Set<number>();

  const make = (row: PsRow): ProcessNode => {
    visited.add(row.pid);
    const children = byPpid.get(row.pid) ?? [];
    return {
      pid: row.pid,
      ppid: row.ppid,
      rss_kb: row.rss_kb,
      pcpu: row.pcpu,
      children: children
        .filter((c) => !visited.has(c.pid))
        .map((c) => make(c)),
    };
  };

  return make(root);
}
