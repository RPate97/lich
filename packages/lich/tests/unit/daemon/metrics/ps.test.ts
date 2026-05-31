import { describe, expect, it } from "vitest";

import { parseCpuTime, parsePsOutput } from "../../../../src/daemon/metrics/ps.js";

describe("parsePsOutput", () => {
  it("parses 5-column output (with TIME column) and discards the header", () => {
    const stdout = `  PID  PPID    RSS %CPU      TIME
    1     0   4096  0.0   0:00.10
   42     1   8192  1.5   1:23.45
  100    42  12000  3.2   12:34:56
`;
    const rows = parsePsOutput(stdout);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rss_kb: 4096, pcpu: 0.0, cpu_time_seconds: 0.1 },
      { pid: 42, ppid: 1, rss_kb: 8192, pcpu: 1.5, cpu_time_seconds: 60 + 23.45 },
      { pid: 100, ppid: 42, rss_kb: 12000, pcpu: 3.2, cpu_time_seconds: 12 * 3600 + 34 * 60 + 56 },
    ]);
  });

  it("treats 4-column output as cpu_time_seconds=0 (back-compat)", () => {
    const stdout = `  PID  PPID    RSS %CPU
    1     0   4096  0.0
   42     1   8192  1.5
`;
    const rows = parsePsOutput(stdout);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rss_kb: 4096, pcpu: 0.0, cpu_time_seconds: 0 },
      { pid: 42, ppid: 1, rss_kb: 8192, pcpu: 1.5, cpu_time_seconds: 0 },
    ]);
  });

  it("skips malformed rows", () => {
    const stdout = `PID PPID RSS %CPU TIME
1 0 1024 0.5 0:01.00
broken row
2 0 not-a-number 0.0 0:00.00
3 0 2048 1.5 0:02.00
`;
    const rows = parsePsOutput(stdout);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rss_kb: 1024, pcpu: 0.5, cpu_time_seconds: 1.0 },
      { pid: 3, ppid: 0, rss_kb: 2048, pcpu: 1.5, cpu_time_seconds: 2.0 },
    ]);
  });

  it("returns an empty array on empty input", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("\n\n")).toEqual([]);
  });
});

describe("parseCpuTime", () => {
  it("parses MM:SS.ff format", () => {
    expect(parseCpuTime("1:23.45")).toBeCloseTo(83.45, 5);
    expect(parseCpuTime("0:00.10")).toBeCloseTo(0.1, 5);
  });
  it("parses HH:MM:SS format", () => {
    expect(parseCpuTime("12:34:56")).toBe(12 * 3600 + 34 * 60 + 56);
  });
  it("parses D-HH:MM:SS Linux format", () => {
    expect(parseCpuTime("2-01:02:03")).toBe(
      2 * 86400 + 1 * 3600 + 2 * 60 + 3,
    );
  });
  it("returns 0 on malformed input", () => {
    expect(parseCpuTime("")).toBe(0);
    expect(parseCpuTime("garbage")).toBe(0);
    expect(parseCpuTime("1.2.3.4")).toBe(0);
  });
});
