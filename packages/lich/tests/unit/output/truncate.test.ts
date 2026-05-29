import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  truncateSpinnerName,
} from "../../../src/output/truncate.js";

function phaseName(idx: number, total: number, services: string[]): string {
  return `start ${idx}/${total} (${services.join(", ")})`;
}

// 11 plausibly-named workers — exercises the overflow case where many
// services-in-flight exceed terminal width.
const WORKER_FIXTURE = [
  "alerts-worker",
  "audit-log-worker",
  "billing-worker",
  "events-worker",
  "imports-worker",
  "metrics-worker",
  "notifications-worker",
  "reports-worker",
  "scheduled-jobs-worker",
  "search-index-worker",
  "webhooks-worker",
];

describe("truncateSpinnerName", () => {
  it("returns the name unchanged when it already fits", () => {
    const name = phaseName(1, 2, ["api", "web"]);
    const out = truncateSpinnerName(name, 200);
    expect(out).toBe(name);
  });

  it("returns the name unchanged on a wide terminal with 11 services", () => {
    const name = phaseName(2, 2, WORKER_FIXTURE);
    const out = truncateSpinnerName(name, 300);
    expect(out).toBe(name);
    expect(name.length).toBeGreaterThan(80);
  });

  it("truncates with `… +N more)` when 11 services overflow a 80-col terminal", () => {
    const name = phaseName(2, 2, WORKER_FIXTURE);
    const out = truncateSpinnerName(name, 80);

    // 80 cols - 2 spinner prefix = 78 available
    expect(out.length).toBeLessThanOrEqual(78);
    expect(out.startsWith("start 2/2 (")).toBe(true);
    expect(out).toMatch(/, … \+\d+ more\)$/);
    expect(out).toContain(WORKER_FIXTURE[0]);
  });

  it("degrades to `(N items)` when even one name + ellipsis won't fit", () => {
    const name = phaseName(2, 2, WORKER_FIXTURE);
    const out = truncateSpinnerName(name, 25);

    expect(out.length).toBeLessThanOrEqual(23);
    expect(out).toBe("start 2/2 (11 items)");
  });

  it("uses singular `item` for a single-element list", () => {
    const longName = "a".repeat(60);
    const out = truncateSpinnerName(`start 1/1 (${longName})`, 40);
    expect(out).toBe("start 1/1 (1 item)");
  });

  it("hard-truncates with `…` when no parenthesized list is present", () => {
    const name = "very-long-phase-name-without-any-list-grouping-at-all";
    const out = truncateSpinnerName(name, 20);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith("…")).toBe(true);
    expect(name.startsWith(out.slice(0, -1))).toBe(true);
  });

  it("hard-truncates as a last resort when even the count form overflows", () => {
    const longPrefix = "this-is-a-ridiculously-long-prefix-that-blows-past";
    const name = `${longPrefix} (a, b, c)`;
    const out = truncateSpinnerName(name, 20);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to default columns when given a non-positive width", () => {
    const name = phaseName(2, 2, WORKER_FIXTURE);
    const zero = truncateSpinnerName(name, 0);
    const negative = truncateSpinnerName(name, -5);
    const nan = truncateSpinnerName(name, Number.NaN);
    const baseline = truncateSpinnerName(name, DEFAULT_COLUMNS);
    expect(zero).toBe(baseline);
    expect(negative).toBe(baseline);
    expect(nan).toBe(baseline);
  });

  it("never returns a string wider than the available width", () => {
    const name = phaseName(2, 2, WORKER_FIXTURE);
    for (let cols = 20; cols <= 200; cols += 7) {
      const out = truncateSpinnerName(name, cols);
      expect(
        out.length,
        `out=${JSON.stringify(out)} exceeded available=${cols - 2}`,
      ).toBeLessThanOrEqual(cols - 2);
    }
  });

  it("handles a list group with a single item that fits", () => {
    const name = "start 1/1 (api)";
    const out = truncateSpinnerName(name, 80);
    expect(out).toBe(name);
  });

  it("preserves the progress counter prefix at all tiers", () => {
    const name = phaseName(3, 5, WORKER_FIXTURE);
    for (const cols of [200, 80, 40]) {
      const out = truncateSpinnerName(name, cols);
      expect(out, `cols=${cols}`).toContain("3/5");
    }
  });
});
