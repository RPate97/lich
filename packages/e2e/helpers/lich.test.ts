import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { runLich } from "./lich.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
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
    // Repo root has no lich.yaml so this exits non-zero with real output —
    // exercises the helper end-to-end without depending on `lich up` semantics.
    const result = runLich(["up"], { cwd: repoRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
