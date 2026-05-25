/**
 * E2E tests for `lich help` (LEV-343, Plan 2 Task 23).
 *
 * Drives the real compiled `lich` binary to verify the discovery surface
 * defined in `packages/lich/src/commands/help.ts` (Task 9) and wired into
 * the router (Task 12). The dogfood-stack's `lich.yaml` (Task 18) declares
 * three user commands (`test:e2e`, `db:psql`, `tools:env-check`) that this
 * suite exercises end-to-end.
 *
 * Coverage matches the testing-standards floor for `lich help`:
 *
 *   1. `lich help` (list mode, with lich.yaml) → both sections present,
 *      every built-in name with a non-empty summary, every user command
 *      from the dogfood yaml listed under "User-defined commands".
 *   2. `lich help <built-in>` → prints the long-form help constant.
 *   3. `lich help <user-cmd>` → prints the user's `help:` text verbatim.
 *   4. `lich help <unknown>` → exit 1, stderr "unknown command".
 *   5. `lich help` in a directory with no lich.yaml → exit 0, lists only
 *      built-ins (no "User-defined commands" section).
 *
 * Why this lives in `tests/e2e/` and not `packages/lich/tests/unit/`:
 *   - The unit suite covers `runHelp()` directly. This file adds the
 *     spawn-the-real-binary tier so the CLI surface (argv parsing, stdout-
 *     vs-stderr routing, exit code) matches what a user would see.
 *
 * Speed: `lich help` is pure config-load (no docker, no supabase, no
 * `lich up`). Each test should finish in under a second.
 */

import { beforeAll, describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Mirrors the pattern used in
// validate-plan2-errors.test.ts: the binary IS our code, and a broken build
// is a real bug to surface loudly. No-op when dist/lich already exists.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

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

// ---------------------------------------------------------------------------
// Shared fixture: a single tmpdir copy of dogfood-stack is amortized across
// the help tests that need a lich.yaml. `lich help` is read-only against the
// config (no state, no ports, no processes), so reusing one copy is safe.
//
// The empty-dir test creates its own fresh tmpdir via mkdtempSync — that
// case explicitly verifies behavior in the ABSENCE of a lich.yaml.
//
// Cleanup happens in afterAll (cheap; no docker/process teardown needed).
// ---------------------------------------------------------------------------

let dogfoodPath: string | null = null;
let dogfoodCleanup: (() => void) | null = null;

// Built-in command names that MUST appear in the `lich help` listing.
// Source of truth: BUILTIN_DISPLAY_ORDER / BUILTIN_SUMMARIES in
// `packages/lich/src/commands/help.ts`. If this list drifts from that file
// the listing assertion catches it.
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
  "help",
  "exec",
  "env",
] as const;

// User commands declared in examples/dogfood-stack/lich.yaml (Plan 2 Task 18).
const USER_COMMAND_NAMES = ["test:e2e", "db:psql", "tools:env-check"] as const;

beforeAll(() => {
  // No `install: true` — `lich help` doesn't run any owned services.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich help", () => {
  it("lists every built-in command with a non-empty summary", () => {
    const result = runLich(["help"], { cwd: dogfoodPath! });

    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich help stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich help stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Built-in commands:");

    // Each built-in must appear on its own line as `  <name>  <summary>`
    // with a non-empty summary. Use a per-name regex so a regression that
    // drops just one summary (e.g. typo in BUILTIN_SUMMARIES) still fails.
    for (const name of BUILT_IN_NAMES) {
      // `^  <name>  <non-empty summary>$` — leading two spaces, name,
      // padding spaces (at least two), then a non-whitespace summary.
      const line = new RegExp(`^ {2}${name} +\\S.*$`, "m");
      expect(
        result.stdout,
        `built-in '${name}' missing or has empty summary in:\n${result.stdout}`,
      ).toMatch(line);
    }
  });

  it("lists user-defined commands when run in a worktree with lich.yaml", () => {
    const result = runLich(["help"], { cwd: dogfoodPath! });

    expect(result.exitCode).toBe(0);
    // The section header is hardcoded in help.ts's runListHelp.
    expect(result.stdout).toContain("User-defined commands");

    for (const name of USER_COMMAND_NAMES) {
      // Same shape as built-ins but the names contain `:` which is fine
      // for our regex (escaped by RegExp constructor when wrapped).
      const line = new RegExp(`^ {2}${name.replace(":", "\\:")} +\\S.*$`, "m");
      expect(
        result.stdout,
        `user command '${name}' missing from listing:\n${result.stdout}`,
      ).toMatch(line);
    }
  });

  it("lich help <built-in> prints the long-form help", () => {
    const result = runLich(["help", "up"], { cwd: dogfoodPath! });

    expect(result.exitCode).toBe(0);
    // Phrase from BUILTIN_LONG_HELP.up in help.ts. If that constant is
    // reworded, update the phrase here in lockstep.
    expect(result.stdout).toContain("Bring the current worktree's stack up");
    expect(result.stdout).toContain("Usage: lich up");
  });

  it("lich help <user-cmd> prints the user's help: text verbatim", () => {
    const result = runLich(["help", "tools:env-check"], {
      cwd: dogfoodPath!,
    });

    expect(result.exitCode).toBe(0);
    // The help text declared in examples/dogfood-stack/lich.yaml under
    // commands.tools:env-check.help — pick a distinctive phrase that's
    // unlikely to collide with any other constant in the output.
    expect(result.stdout).toContain(
      "Diagnostic: print the env vars that should be visible under the",
    );
    // The command name header that runPerCommandHelp emits before the
    // user-supplied body.
    expect(result.stdout).toContain("lich tools:env-check");
  });

  it("lich help <unknown> exits 1", () => {
    const result = runLich(["help", "does:not:exist"], {
      cwd: dogfoodPath!,
    });

    expect(result.exitCode).toBe(1);
    // Error text from runPerCommandHelp when neither built-in nor user
    // command matches. Stderr is the right sink (not stdout) because the
    // request is unsuccessful.
    expect(result.stderr).toContain("unknown command 'does:not:exist'");
  });

  it("works in a directory with no lich.yaml (built-ins only)", () => {
    // mkdtempSync directly — NOT copyExampleToTmpdir. The whole point of
    // this test is the absence of lich.yaml.
    const emptyDir = mkdtempSync(join(tmpdir(), "lich-e2e-help-empty-"));
    try {
      const result = runLich(["help"], { cwd: emptyDir });

      expect(result.exitCode).toBe(0);
      // Built-ins must still list.
      expect(result.stdout).toContain("Built-in commands:");
      for (const name of BUILT_IN_NAMES) {
        const line = new RegExp(`^ {2}${name} +\\S.*$`, "m");
        expect(result.stdout).toMatch(line);
      }
      // No User-defined commands section when no yaml is present.
      expect(result.stdout).not.toContain("User-defined commands");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
