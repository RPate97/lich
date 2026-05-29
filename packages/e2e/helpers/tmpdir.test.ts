import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyExampleToTmpdir } from "./tmpdir.js";

let cleanup: (() => void) | null = null;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

describe("copyExampleToTmpdir", () => {
  it("copies the dogfood-stack example to a fresh tmpdir", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "lich.yaml"))).toBe(true);
    expect(existsSync(join(path, "apps/api/src/index.ts"))).toBe(true);
    expect(existsSync(join(path, "db/migrations/01_init.sql"))).toBe(true);

    const yaml = readFileSync(join(path, "lich.yaml"), "utf8");
    expect(yaml).toContain("owned:");
    // Asserting on "dev:fast:" catches regressions to the default profile.
    expect(yaml).toContain("dev:fast:");
    expect(yaml).toContain("postgres:");
  });

  it("cleanup removes the tmpdir", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    expect(existsSync(path)).toBe(true);
    cleanupFn();
    expect(existsSync(path)).toBe(false);
    cleanup = null;
  });
});
