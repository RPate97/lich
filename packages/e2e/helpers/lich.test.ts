import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { runLich } from "./lich.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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

  it("captures stdout and exit code for a real command (lich up with no config)", () => {
    // Running `lich up` from the repo root (which has no lich.yaml) is a
    // convenient way to exercise the helper end-to-end: the binary spawns,
    // produces real output, exits non-zero. We assert on the helper's
    // contract (exitCode + stdout captured), not on the specific message
    // text — actual `lich up` behavior is covered by the e2e suite for
    // that command.
    const result = runLich(["up"], { cwd: repoRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
