/**
 * E2E tests for `lich validate` Plan 2 error paths (LEV-344, Task 24).
 *
 * Drives the real compiled `lich` binary against a directory of intentionally
 * invalid YAML fixtures and asserts the failure modes Plan 2 added to
 * `commands/validate.ts`:
 *
 *   1. `commands.<name>` shadowing a built-in (kind: "shadow") — Task 14.
 *   2. Cycle in `env_groups.<name>.extends` (kind: "cycle") — Task 15.
 *   3. Unresolved `env_group` reference from `commands.<name>` (kind: "ref")
 *      — Task 16.
 *   4. Same as (3) but the typo is one edit away from a declared name; the
 *      error must include a "did you mean" suggestion — Task 16.
 *   5. Unresolved `env_group` reference from `env_groups.<name>.extends`
 *      (kind: "ref") — Task 16.
 *   6. `--json` mode: the structured report carries the correct `errors[].kind`
 *      across all of the above categories — Task 14/15/16.
 *
 * Why this lives in `tests/e2e/` and not `packages/lich/tests/unit/`:
 *   - The unit suite already covers each check's logic against `runValidate()`
 *     directly. This file adds the spawn-the-real-binary tier so we know the
 *     CLI surface (path arg resolution, stdout-vs-stderr routing of
 *     pretty/JSON output, exit code) matches what a user would see.
 *
 * Pretty vs JSON output routing — locked by probing the binary before writing
 * these tests:
 *   - Pretty output for `!ok` reports goes to STDERR (the validate command
 *     swaps `out → err` for the error sink).
 *   - JSON output always goes to STDOUT (regardless of `ok`).
 *   These tests assert on whichever stream the output actually lands on.
 *
 * Speed: these fixtures are pure config — no `lich up`, no docker. Each
 * test should finish in well under a second.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Mirrors the pattern used in basic-up.test.ts:
// the binary IS our code, and a broken build is a real bug to surface
// loudly. No-op when dist/lich already exists.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/invalid-yamls");

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
// Tests
// ---------------------------------------------------------------------------

describe("lich validate — Plan 2 error paths", () => {
  it("refuses a user command whose name shadows a built-in (shadow-builtin.yaml)", () => {
    const result = runLich(["validate", "shadow-builtin.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Pretty error output for `!ok` lands on stderr. The exact wording comes
    // from `checkCommandShadowing` in `commands/validate.ts` (Task 14).
    expect(result.stderr).toContain("commands.up shadows the built-in 'lich up'");
    // Also includes the suggested rename ('up:run' or similar).
    expect(result.stderr).toContain("up:run");
  });

  it("detects a 2-node cycle in env_groups.extends (env-groups-cycle.yaml)", () => {
    const result = runLich(["validate", "env-groups-cycle.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `checkEnvGroupExtendsCycles` (Task 15) — mirrors
    // the `cycle in depends_on: a → b → a` format for consistency.
    expect(result.stderr).toContain("cycle in env_groups extends");
    expect(result.stderr).toContain("a → b → a");
  });

  it("refuses an undeclared env_group reference from a user command (env-group-undeclared.yaml)", () => {
    const result = runLich(["validate", "env-group-undeclared.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `checkEnvGroupReferences` (Task 16). With NO declared
    // groups and "ghost" not being close to "stack", no `did you mean` hint.
    expect(result.stderr).toContain('env_group "ghost" not declared');
    expect(result.stderr).toContain("/commands/foo/env_group");
  });

  it("suggests a close-match name on env_group typo (env-group-typo-suggestion.yaml)", () => {
    const result = runLich(["validate", "env-group-typo-suggestion.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // The Levenshtein suggester in validate.ts finds "infisical-prod" as the
    // close match for "infisical-prdo" (1 edit) and appends a hint.
    expect(result.stderr).toContain('env_group "infisical-prdo" not declared');
    expect(result.stderr).toContain('did you mean "infisical-prod"');
  });

  it("refuses env_groups.<name>.extends pointing at an undeclared group (env-group-extends-missing.yaml)", () => {
    const result = runLich(["validate", "env-group-extends-missing.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('env_group "nonexistent" not declared');
    expect(result.stderr).toContain("/env_groups/a/extends");
  });

  // -------------------------------------------------------------------------
  // --json structural test
  // -------------------------------------------------------------------------
  //
  // One test exercises `--json` against each of the three failure categories
  // (shadow, cycle, ref) and asserts the resulting JSON report carries the
  // expected `errors[].kind` discriminator. This is the load-bearing assertion
  // for any downstream tooling that consumes `lich validate --json` (CI
  // dashboards, editor extensions, etc.).
  // -------------------------------------------------------------------------
  it("--json emits the expected errors[].kind across shadow / cycle / ref categories", () => {
    interface JsonReport {
      ok: boolean;
      path: string;
      errors?: Array<{ kind: string; location: string; message: string }>;
    }

    const cases: Array<{ fixture: string; expectedKind: string }> = [
      { fixture: "shadow-builtin.yaml", expectedKind: "shadow" },
      { fixture: "env-groups-cycle.yaml", expectedKind: "cycle" },
      { fixture: "env-group-undeclared.yaml", expectedKind: "ref" },
      { fixture: "env-group-extends-missing.yaml", expectedKind: "ref" },
    ];

    const seenKinds = new Set<string>();

    for (const { fixture, expectedKind } of cases) {
      const result = runLich(["validate", "--json", fixture], {
        cwd: fixturesDir,
      });

      expect(result.exitCode, `${fixture} should exit 1`).toBe(1);

      // JSON output goes to STDOUT regardless of ok-ness.
      let report: JsonReport;
      try {
        report = JSON.parse(result.stdout) as JsonReport;
      } catch (e) {
        throw new Error(
          `failed to parse JSON report for ${fixture}: ${(e as Error).message}\nstdout was: ${result.stdout}\nstderr was: ${result.stderr}`,
        );
      }

      expect(report.ok, `${fixture}: report.ok should be false`).toBe(false);
      expect(report.errors, `${fixture}: report should have errors[]`).toBeDefined();
      expect(report.errors!.length).toBeGreaterThan(0);

      const kinds = report.errors!.map((e) => e.kind);
      expect(
        kinds,
        `${fixture}: expected errors[].kind to include "${expectedKind}", got ${JSON.stringify(kinds)}`,
      ).toContain(expectedKind);

      for (const k of kinds) seenKinds.add(k);
    }

    // Sanity: across the case set we should have observed all three Plan-2
    // failure-kind discriminators. This guards against a future regression
    // where two cases accidentally collapse to the same kind.
    expect(seenKinds).toContain("shadow");
    expect(seenKinds).toContain("cycle");
    expect(seenKinds).toContain("ref");
  });
});
