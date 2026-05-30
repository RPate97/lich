import { describe, expect, it } from "vitest";

import {
  parseDockerStats,
  parseMemUsage,
  parsePercent,
  parseSizeToBytes,
} from "../../../../src/daemon/metrics/docker-stats.js";

describe("parsePercent", () => {
  it("parses standard percent strings", () => {
    expect(parsePercent("12.34%")).toBe(12.34);
    expect(parsePercent("0%")).toBe(0);
    expect(parsePercent("100%")).toBe(100);
  });

  it("tolerates missing percent sign", () => {
    expect(parsePercent("3.5")).toBe(3.5);
  });

  it("returns 0 on garbage", () => {
    expect(parsePercent("--")).toBe(0);
    expect(parsePercent("")).toBe(0);
  });
});

describe("parseSizeToBytes", () => {
  it("parses MiB / GiB (binary)", () => {
    expect(parseSizeToBytes("1MiB")).toBe(1024 * 1024);
    expect(parseSizeToBytes("2GiB")).toBe(2 * 1024 ** 3);
  });

  it("parses MB / GB (decimal)", () => {
    expect(parseSizeToBytes("1MB")).toBe(1_000_000);
    expect(parseSizeToBytes("2GB")).toBe(2 * 1_000_000_000);
  });

  it("parses bare bytes", () => {
    expect(parseSizeToBytes("1024B")).toBe(1024);
    expect(parseSizeToBytes("1024")).toBe(1024);
  });

  it("returns undefined on garbage", () => {
    expect(parseSizeToBytes("nonsense")).toBeUndefined();
    expect(parseSizeToBytes("")).toBeUndefined();
  });
});

describe("parseMemUsage", () => {
  it("parses used / limit pairs", () => {
    expect(parseMemUsage("15.3MiB / 8GiB")).toEqual({
      used: Math.round(15.3 * 1024 ** 2),
      limit: 8 * 1024 ** 3,
    });
  });

  it("handles missing limit", () => {
    expect(parseMemUsage("12MB")).toEqual({ used: 12_000_000 });
  });

  it("returns zero on empty input", () => {
    expect(parseMemUsage("")).toEqual({ used: 0 });
  });
});

describe("parseDockerStats", () => {
  it("parses JSON-per-line docker stats output", () => {
    const stdout =
      `{"ID":"abc123","Name":"lich-foo-postgres-1","CPUPerc":"2.10%","MemUsage":"124.0MiB / 8.0GiB"}\n` +
      `{"ID":"def456","Name":"lich-foo-redis-1","CPUPerc":"0.05%","MemUsage":"5.2MiB / 8.0GiB"}\n`;
    const rows = parseDockerStats(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0].container_id).toBe("abc123");
    expect(rows[0].name).toBe("lich-foo-postgres-1");
    expect(rows[0].cpu_pct).toBeCloseTo(2.1, 5);
    expect(rows[0].mem_bytes).toBe(Math.round(124.0 * 1024 ** 2));
    expect(rows[0].mem_limit_bytes).toBe(8 * 1024 ** 3);
  });

  it("skips malformed JSON lines without crashing", () => {
    const stdout = `not-json\n{"ID":"x","Name":"y","CPUPerc":"1%","MemUsage":"10MB / 100MB"}\n`;
    const rows = parseDockerStats(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].container_id).toBe("x");
  });

  it("returns [] on empty input", () => {
    expect(parseDockerStats("")).toEqual([]);
  });
});
