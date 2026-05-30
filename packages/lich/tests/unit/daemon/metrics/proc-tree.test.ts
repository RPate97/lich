import { describe, expect, it } from "vitest";

import {
  aggregateSubtree,
  buildTree,
  indexByPid,
  indexByPpid,
} from "../../../../src/daemon/metrics/proc-tree.js";
import type { PsRow } from "../../../../src/daemon/metrics/types.js";

function rows(): PsRow[] {
  return [
    { pid: 1, ppid: 0, rss_kb: 1024, pcpu: 0.1, cpu_time_seconds: 0.5 },
    // parent we're aggregating
    { pid: 100, ppid: 1, rss_kb: 10_000, pcpu: 1.0, cpu_time_seconds: 5 },
    // direct child
    { pid: 200, ppid: 100, rss_kb: 20_000, pcpu: 2.0, cpu_time_seconds: 10 },
    // grandchild
    { pid: 250, ppid: 200, rss_kb: 5_000, pcpu: 0.5, cpu_time_seconds: 2 },
    // second direct child
    { pid: 201, ppid: 100, rss_kb: 30_000, pcpu: 3.0, cpu_time_seconds: 15 },
    // sibling — must not be included
    { pid: 999, ppid: 1, rss_kb: 99_000, pcpu: 99.0, cpu_time_seconds: 500 },
  ];
}

describe("aggregateSubtree", () => {
  it("sums RSS and pcpu across the full subtree", () => {
    const r = rows();
    const byPid = indexByPid(r);
    const byPpid = indexByPpid(r);
    const agg = aggregateSubtree(100, byPid, byPpid);
    expect(agg.process_count).toBe(4); // 100, 200, 250, 201
    expect(agg.mem_bytes).toBe((10_000 + 20_000 + 5_000 + 30_000) * 1024);
    expect(agg.cpu_pct_cumulative).toBeCloseTo(1.0 + 2.0 + 0.5 + 3.0, 5);
    expect(agg.pids.sort((a, b) => a - b)).toEqual([100, 200, 201, 250]);
  });

  it("returns zeros when the root pid isn't in the snapshot", () => {
    const r = rows();
    const byPid = indexByPid(r);
    const byPpid = indexByPpid(r);
    const agg = aggregateSubtree(99999, byPid, byPpid);
    expect(agg).toEqual({
      mem_bytes: 0,
      cpu_pct_cumulative: 0,
      cpu_time_seconds: 0,
      process_count: 0,
      pids: [],
    });
  });

  it("matches the LEV-538 acceptance criterion: parent + 3 children", () => {
    // Spawn-parent + 3 fork-children scenario the spec calls out.
    const r: PsRow[] = [
      { pid: 1000, ppid: 1, rss_kb: 50_000, pcpu: 1.0, cpu_time_seconds: 1 },
      { pid: 1001, ppid: 1000, rss_kb: 100_000, pcpu: 2.0, cpu_time_seconds: 2 },
      { pid: 1002, ppid: 1000, rss_kb: 100_000, pcpu: 2.0, cpu_time_seconds: 2 },
      { pid: 1003, ppid: 1000, rss_kb: 100_000, pcpu: 2.0, cpu_time_seconds: 2 },
    ];
    const agg = aggregateSubtree(1000, indexByPid(r), indexByPpid(r));
    expect(agg.process_count).toBe(4);
    expect(agg.mem_bytes).toBe((50_000 + 3 * 100_000) * 1024);
    expect(agg.cpu_pct_cumulative).toBeCloseTo(1.0 + 3 * 2.0, 5);
    expect(agg.cpu_time_seconds).toBeCloseTo(1 + 3 * 2, 5);
  });

  it("is cycle-safe — duplicated entries don't double-count", () => {
    // Defensive: ps shouldn't emit cycles, but the aggregator must not loop.
    const r: PsRow[] = [
      { pid: 1, ppid: 0, rss_kb: 100, pcpu: 0.1, cpu_time_seconds: 0.1 },
      { pid: 1, ppid: 0, rss_kb: 100, pcpu: 0.1, cpu_time_seconds: 0.1 },
    ];
    const agg = aggregateSubtree(1, indexByPid(r), indexByPpid(r));
    expect(agg.process_count).toBe(1);
  });
});

describe("buildTree", () => {
  it("builds a nested tree with children populated", () => {
    const r = rows();
    const tree = buildTree(100, indexByPid(r), indexByPpid(r));
    expect(tree).not.toBeNull();
    expect(tree!.pid).toBe(100);
    expect(tree!.children).toHaveLength(2);
    const c200 = tree!.children.find((c) => c.pid === 200);
    expect(c200).toBeDefined();
    expect(c200!.children).toHaveLength(1);
    expect(c200!.children[0].pid).toBe(250);
  });

  it("returns null when the root pid isn't in the snapshot", () => {
    expect(buildTree(99999, indexByPid([]), indexByPpid([]))).toBeNull();
  });
});
