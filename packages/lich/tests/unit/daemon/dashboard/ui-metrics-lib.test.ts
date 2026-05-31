import { describe, expect, it } from "vitest";

import {
  cpuLoad,
  formatBytes,
  formatCpuPct,
  memLoad,
} from "../../../../src/daemon/dashboard/ui/lib/metrics.js";

describe("formatBytes", () => {
  it("returns 0 B for non-positive or non-finite", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
  it("formats bytes / KB / MB / GB ranges", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});

describe("formatCpuPct", () => {
  it("fixed one decimal", () => {
    expect(formatCpuPct(0)).toBe("0.0%");
    expect(formatCpuPct(12.345)).toBe("12.3%");
    expect(formatCpuPct(99.99)).toBe("100.0%");
  });
  it("handles non-finite", () => {
    expect(formatCpuPct(Number.NaN)).toBe("0.0%");
    expect(formatCpuPct(Number.POSITIVE_INFINITY)).toBe("0.0%");
  });
});

describe("cpuLoad thresholds", () => {
  it("idle at zero and below", () => {
    expect(cpuLoad(0)).toBe("idle");
    expect(cpuLoad(-0.5)).toBe("idle");
    expect(cpuLoad(Number.NaN)).toBe("idle");
  });
  it("low under 50%", () => {
    expect(cpuLoad(0.1)).toBe("low");
    expect(cpuLoad(49.9)).toBe("low");
  });
  it("mid between 50 and 80", () => {
    expect(cpuLoad(50)).toBe("mid");
    expect(cpuLoad(79.9)).toBe("mid");
  });
  it("high at 80 and above", () => {
    expect(cpuLoad(80)).toBe("high");
    expect(cpuLoad(150)).toBe("high");
  });
});

describe("memLoad with limits", () => {
  it("idle when no limit set", () => {
    expect(memLoad(100_000_000)).toBe("idle");
    expect(memLoad(100_000_000, 0)).toBe("idle");
  });
  it("low under 65%", () => {
    expect(memLoad(50, 100)).toBe("low");
    expect(memLoad(64, 100)).toBe("low");
  });
  it("mid between 65% and 85%", () => {
    expect(memLoad(65, 100)).toBe("mid");
    expect(memLoad(84, 100)).toBe("mid");
  });
  it("high at 85% and above", () => {
    expect(memLoad(85, 100)).toBe("high");
    expect(memLoad(120, 100)).toBe("high");
  });
});
