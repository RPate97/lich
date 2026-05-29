import { beforeAll, describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

let dogfoodPath: string | null = null;
let dogfoodCleanup: (() => void) | null = null;

// Source of truth: BUILTIN_DISPLAY_ORDER in packages/lich/src/commands/help.ts
const BUILT_IN_NAMES = [
  "up",
  "down",
  "restart",
  "logs",
  "urls",
  "stacks",
  "nuke",
  "init",
  "validate",
  "exec",
  "env",
] as const;

const USER_COMMAND_NAMES = ["test:e2e", "db:psql", "tools:env-check"] as const;

beforeAll(() => {
  const copy = copyExampleToTmpdir("dogfood-stack");
  dogfoodPath = copy.path;
  dogfoodCleanup = copy.cleanup;
});

afterAll(() => {
  if (dogfoodCleanup) {
    try {
      dogfoodCleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("teardown dogfood cleanup failed:", err);
    }
    dogfoodCleanup = null;
    dogfoodPath = null;
  }
});

describe("lich --help (global)", () => {
  it("lists every built-in command with a non-empty summary", () => {
    const result = runLich(["--help"], { cwd: dogfoodPath! });

    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich --help stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich --help stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Built-in commands:");

    for (const name of BUILT_IN_NAMES) {
      const line = new RegExp(`^ {2}${name} +\\S.*$`, "m");
      expect(
        result.stdout,
        `built-in '${name}' missing or has empty summary in:\n${result.stdout}`,
      ).toMatch(line);
    }
  });

  it("does NOT list 'help' as a built-in", () => {
    const result = runLich(["--help"], { cwd: dogfoodPath! });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/^ {2}help\b/m);
  });

  it("lists user-defined commands when run in a worktree with lich.yaml", () => {
    const result = runLich(["--help"], { cwd: dogfoodPath! });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("User-defined commands");

    for (const name of USER_COMMAND_NAMES) {
      const line = new RegExp(`^ {2}${name.replace(":", "\\:")} +\\S.*$`, "m");
      expect(
        result.stdout,
        `user command '${name}' missing from listing:\n${result.stdout}`,
      ).toMatch(line);
    }
  });

  it("works in a directory with no lich.yaml (built-ins only)", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "lich-e2e-help-empty-"));
    try {
      const result = runLich(["--help"], { cwd: emptyDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Built-in commands:");
      for (const name of BUILT_IN_NAMES) {
        const line = new RegExp(`^ {2}${name} +\\S.*$`, "m");
        expect(result.stdout).toMatch(line);
      }
      expect(result.stdout).not.toContain("User-defined commands");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("prints global help when invoked with no command and no flag", () => {
    const result = runLich([], { cwd: dogfoodPath! });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Built-in commands:");
  });
});

describe("lich <subcommand> --help (per-command)", () => {
  it("prints long-form help for a built-in", () => {
    const result = runLich(["up", "--help"], { cwd: dogfoodPath! });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bring the current worktree's stack up");
    expect(result.stdout).toContain("Usage: lich up");
  });

  it("lich up --help lists profiles from the local lich.yaml", () => {
    const result = runLich(["up", "--help"], { cwd: dogfoodPath! });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available profiles");
    expect(result.stdout).toMatch(/^ {2}dev\b/m);
    expect(result.stdout).toMatch(/^ {2}dev:fast\b/m);
  });

  it("prints the user's help: text verbatim for a user command", () => {
    const result = runLich(["tools:env-check", "--help"], {
      cwd: dogfoodPath!,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Diagnostic: print the env vars that should be visible under the",
    );
    expect(result.stdout).toContain("lich tools:env-check");
  });

  it("exits 1 on --help for an unknown command", () => {
    const result = runLich(["does:not:exist", "--help"], {
      cwd: dogfoodPath!,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'does:not:exist'");
  });
});

describe("`lich help` is no longer recognised", () => {
  it("exits non-zero with 'unknown command' for `lich help`", () => {
    const result = runLich(["help"], { cwd: dogfoodPath! });
    // `help` is no longer a built-in; it falls through to user-command
    // dispatch which prints 'unknown command' and exits non-zero. The
    // contract is simply: it's not the help command anymore.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("unknown command");
  });
});
