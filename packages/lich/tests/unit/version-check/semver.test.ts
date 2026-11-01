import { describe, it, expect } from "vitest";
import { compareVersions, isOutdated } from "../../../src/version-check/semver.js";

describe("compareVersions", () => {
  it("returns negative when a < b", () => {
    expect(compareVersions("0.4.0", "0.6.2")).toBeLessThan(0);
    expect(compareVersions("0.6.1", "0.6.2")).toBeLessThan(0);
    expect(compareVersions("0.6.2", "1.0.0")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareVersions("0.6.2", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("returns 0 when equal", () => {
    expect(compareVersions("0.6.2", "0.6.2")).toBe(0);
  });

  it("ignores a leading v on either side", () => {
    expect(compareVersions("v0.6.2", "0.6.2")).toBe(0);
    expect(compareVersions("0.4.0", "v0.6.2")).toBeLessThan(0);
  });

  it("returns null for unparseable input", () => {
    expect(compareVersions("not-a-version", "0.6.2")).toBeNull();
    expect(compareVersions("0.6.2", "")).toBeNull();
    expect(compareVersions("0.6", "0.6.2")).toBeNull();
    expect(compareVersions("0.0.0-dev", "0.6.2")).toBeNull();
  });
});

describe("isOutdated", () => {
  it("is true when current is strictly behind latest", () => {
    expect(isOutdated("0.4.0", "0.6.2")).toBe(true);
  });

  it("is false when current matches latest", () => {
    expect(isOutdated("0.6.2", "0.6.2")).toBe(false);
  });

  it("is false when current is ahead of latest", () => {
    expect(isOutdated("0.7.0", "0.6.2")).toBe(false);
  });

  it("is false when either side is unparseable (fail-safe)", () => {
    expect(isOutdated("0.0.0-dev", "0.6.2")).toBe(false);
    expect(isOutdated("0.6.2", "garbage")).toBe(false);
  });
});
