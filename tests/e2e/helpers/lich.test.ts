import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { runLich } from "./lich.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  // Ensure the lich binary is built before running these tests.
  if (!existsSync(lichBinary)) {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
    });
    if (build.status !== 0) {
      throw new Error("Failed to build lich binary");
    }
  }
});

describe("runLich", () => {
  it("returns version when called with --version", () => {
    const result = runLich(["--version"], { cwd: repoRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^lich \d/);
  });

  it("returns non-zero exit code for unknown command", () => {
    const result = runLich(["definitely-not-a-command"], { cwd: repoRoot });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("returns 'not yet implemented' for up command (current stub state)", () => {
    const result = runLich(["up"], { cwd: repoRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not yet implemented");
  });
});
