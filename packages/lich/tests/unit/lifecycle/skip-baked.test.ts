import { describe, test, expect } from "vitest";
import { filterBakedHooks, shouldSkipBaked } from "../../../src/lifecycle/skip-baked.js";
import type { LifecycleList } from "../../../src/config/types.js";

describe("filterBakedHooks", () => {
  const all: LifecycleList = [
    "psql migrations.sql",
    { cmd: "echo baked default" },
    { cmd: "echo baked explicit", per_fork: false },
    { cmd: "echo per-fork", per_fork: true },
  ];

  test("skipBaked=false returns all entries unchanged", () => {
    expect(filterBakedHooks(all, false)).toEqual(all);
  });

  test("skipBaked=true keeps only per_fork:true entries", () => {
    expect(filterBakedHooks(all, true)).toEqual([{ cmd: "echo per-fork", per_fork: true }]);
  });

  test("string entries never survive skipBaked=true (no per_fork field)", () => {
    expect(filterBakedHooks(["a", "b"], true)).toEqual([]);
  });

  test("empty input returns empty regardless of mode", () => {
    expect(filterBakedHooks([], false)).toEqual([]);
    expect(filterBakedHooks([], true)).toEqual([]);
  });
});

describe("shouldSkipBaked", () => {
  test("LICH_SKIP_BAKED=1 returns true", () => {
    expect(shouldSkipBaked({ LICH_SKIP_BAKED: "1" })).toBe(true);
  });
  test("LICH_SKIP_BAKED=0 returns false", () => {
    expect(shouldSkipBaked({ LICH_SKIP_BAKED: "0" })).toBe(false);
  });
  test("LICH_SKIP_BAKED unset returns false", () => {
    expect(shouldSkipBaked({})).toBe(false);
  });
  test("LICH_SKIP_BAKED='true' returns false (strict '1' check)", () => {
    expect(shouldSkipBaked({ LICH_SKIP_BAKED: "true" })).toBe(false);
  });
});
