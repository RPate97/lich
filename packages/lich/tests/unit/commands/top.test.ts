import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatCpuPct,
  renderTable,
  renderTreeNode,
} from "../../../src/commands/top.js";
import type { StackMetricsSnapshot } from "../../../src/daemon/metrics/types.js";

describe("formatBytes", () => {
  it("formats values across the size range", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });
});

describe("formatCpuPct", () => {
  it("renders with one decimal + percent sign", () => {
    expect(formatCpuPct(0)).toBe("0.0%");
    expect(formatCpuPct(12.345)).toBe("12.3%");
    expect(formatCpuPct(100)).toBe("100.0%");
  });
});

describe("renderTable", () => {
  function snap(): StackMetricsSnapshot {
    return {
      stack_id: "feat-x-deadbeef",
      sampled_at: "2026-05-30T00:00:00Z",
      total: { cpu_pct: 62.4, mem_bytes: 3_960_000_000 },
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          container_id: "abc",
          cpu_pct: 2.1,
          mem_bytes: 124 * 1024 ** 2,
          mem_limit_bytes: 8 * 1024 ** 3,
          uptime_seconds: 60 * 60 * 2 + 60 * 14,
        },
        {
          name: "api",
          kind: "owned",
          state: "ready",
          pid: 4521,
          cpu_pct: 18.7,
          mem_bytes: 412 * 1024 ** 2,
          uptime_seconds: 60 * 60 * 2 + 60 * 14,
          process_count: 3,
        },
        {
          name: "web",
          kind: "owned",
          state: "ready",
          pid: 4530,
          cpu_pct: 24.3,
          mem_bytes: Math.round(1.2 * 1024 ** 3),
          uptime_seconds: 60 * 60 * 2 + 60 * 14,
          process_count: 5,
        },
      ],
    };
  }

  it("includes SERVICE / PID / STATE / CPU% / MEM / UPTIME columns + TOTAL row", () => {
    const out = renderTable([snap()], {}, { sort: "cpu", showStackHeader: false });
    expect(out).toContain("SERVICE");
    expect(out).toContain("PID");
    expect(out).toContain("STATE");
    expect(out).toContain("CPU%");
    expect(out).toContain("MEM");
    expect(out).toContain("UPTIME");
    expect(out).toContain("TOTAL");
    expect(out).toContain("postgres");
    expect(out).toContain("api");
    expect(out).toContain("web");
    expect(out).toContain("(container)");
    expect(out).toContain("(3 procs)");
    expect(out).toContain("(5 procs)");
  });

  it("sorts by CPU descending by default", () => {
    const out = renderTable([snap()], {}, { sort: "cpu", showStackHeader: false });
    const lines = out.split("\n").filter((l) => l.length > 0);
    // header, web (24.3), api (18.7), postgres (2.1), total
    expect(lines[1]).toContain("web");
    expect(lines[2]).toContain("api");
    expect(lines[3]).toContain("postgres");
  });

  it("respects --sort=name", () => {
    const out = renderTable([snap()], {}, { sort: "name", showStackHeader: false });
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines[1]).toContain("api");
    expect(lines[2]).toContain("postgres");
    expect(lines[3]).toContain("web");
  });

  it("prepends a `stack:` header when multiple stacks are passed", () => {
    const out = renderTable(
      [snap(), { ...snap(), stack_id: "other-id", services: [] }],
      { "feat-x-deadbeef": "feat-x", "other-id": "feat-y" },
      { sort: "cpu", showStackHeader: true },
    );
    expect(out).toContain("stack: feat-x");
    expect(out).toContain("stack: feat-y");
  });
});

describe("renderTreeNode", () => {
  it("indents children under the parent", () => {
    const tree = {
      pid: 1000,
      ppid: 1,
      rss_kb: 50_000,
      pcpu: 5.0,
      children: [
        {
          pid: 1001,
          ppid: 1000,
          rss_kb: 100_000,
          pcpu: 10.0,
          children: [],
        },
        {
          pid: 1002,
          ppid: 1000,
          rss_kb: 100_000,
          pcpu: 10.0,
          children: [],
        },
      ],
    };
    const out = renderTreeNode(tree, "");
    expect(out).toMatch(/pid 1000/);
    expect(out).toMatch(/pid 1001/);
    expect(out).toMatch(/pid 1002/);
    const lines = out.split("\n").filter((l) => l.length > 0);
    // children indented further than parent
    expect(lines[1].startsWith("   ")).toBe(true);
    expect(lines[2].startsWith("   ")).toBe(true);
  });
});
