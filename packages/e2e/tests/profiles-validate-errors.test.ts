
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Mirrors the pattern used in
// `validate-plan2-errors.test.ts` and `basic-up.test.ts`: the binary IS our
// code, and a broken build is a real bug to surface loudly. No-op when
// `dist/lich` already exists.
// ---------------------------------------------------------------------------

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/invalid-yamls");

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

describe("lich validate — Plan 3 profile error paths", () => {
  it("refuses a profile.owned entry pointing at an undeclared owned service (profile-undeclared-service.yaml)", () => {
    const result = runLich(["validate", "profile-undeclared-service.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Pretty error output for `!ok` lands on stderr. The exact message comes
    // from `checkProfiles` in `commands/validate.ts` (Task 9 / LEV-383).
    expect(result.stderr).toContain(
      'references unknown owned service "missing"',
    );
    expect(result.stderr).toContain("/profiles/dev/owned/1");
  });

  it("detects a 2-node cycle in profiles.extends (profile-extends-cycle.yaml)", () => {
    const result = runLich(["validate", "profile-extends-cycle.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `checkProfileExtendsCycles` (Task 10 / LEV-384) —
    // mirrors `cycle in depends_on: a → b → a` and
    // `cycle in env_groups extends: …` for consistency.
    expect(result.stderr).toContain("cycle in profiles extends");
    // Closed-walk format: start node repeated. The detector may walk from
    // either end of the cycle depending on iteration order, so allow both.
    expect(result.stderr).toMatch(/a → b → a|b → a → b/);
  });

  it("refuses two profiles with default: true (profile-two-defaults.yaml)", () => {
    const result = runLich(["validate", "profile-two-defaults.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `pickDefaultProfile` (Plan 3 Task 3 / LEV-377),
    // surfaced via `checkProfileDefaultsAndExtends` (Task 11 / LEV-385).
    // Profile names are sorted alphabetically for determinism.
    expect(result.stderr).toContain(
      "multiple profiles set default: true: alpha, beta",
    );
  });

  it("refuses profiles.X.extends pointing at an undeclared profile (profile-extends-missing.yaml)", () => {
    const result = runLich(["validate", "profile-extends-missing.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `checkProfileDefaultsAndExtends` (Task 11 / LEV-385).
    expect(result.stderr).toContain('extends unknown profile "nonexistent"');
    expect(result.stderr).toContain("/profiles/dev/extends");
    // Single-string form has no `/extends/<i>` index suffix.
    expect(result.stderr).not.toContain("/profiles/dev/extends/");
  });

  it("flags a profile that leaves a top-level interp ref uncovered (profile-interp-uncovered.yaml)", () => {
    const result = runLich(["validate", "profile-interp-uncovered.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Message shape from `checkProfileInterpolations` (Task 12 / LEV-386).
    // The top-level value references `${owned.supabase.port}` and survives
    // unchanged into the `lite` profile, which excludes `supabase`.
    expect(result.stderr).toContain('under profile "lite"');
    expect(result.stderr).toContain("supabase");
    // The location points at the surviving (top-level) layer rather than at
    // a profile-scoped override, since `lite` does not override DATABASE_URL.
    expect(result.stderr).toContain("(/env/DATABASE_URL)");
  });

  // -------------------------------------------------------------------------
  // --json structural test
  // -------------------------------------------------------------------------
  //
  // One test exercises `--json` against every Plan 3 profile failure category
  // and asserts the resulting JSON report carries the expected
  // `errors[].kind` discriminator. This is the load-bearing assertion for any
  // downstream tooling that consumes `lich validate --json` (CI dashboards,
  // editor extensions, etc.) — Tasks 9-12 spread the four profile-specific
  // failure kinds (`ref`, `cycle`, `schema`, `interp`) across the validator
  // and this test pins all four end-to-end through the binary.
  // -------------------------------------------------------------------------
  it("--json emits the expected errors[].kind across ref / cycle / schema / interp categories", () => {
    interface JsonReport {
      ok: boolean;
      path: string;
      errors?: Array<{ kind: string; location: string; message: string }>;
    }

    const cases: Array<{ fixture: string; expectedKind: string }> = [
      { fixture: "profile-undeclared-service.yaml", expectedKind: "ref" },
      { fixture: "profile-extends-cycle.yaml", expectedKind: "cycle" },
      { fixture: "profile-two-defaults.yaml", expectedKind: "schema" },
      { fixture: "profile-extends-missing.yaml", expectedKind: "ref" },
      { fixture: "profile-interp-uncovered.yaml", expectedKind: "interp" },
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
      expect(
        report.errors,
        `${fixture}: report should have errors[]`,
      ).toBeDefined();
      expect(report.errors!.length).toBeGreaterThan(0);

      const kinds = report.errors!.map((e) => e.kind);
      expect(
        kinds,
        `${fixture}: expected errors[].kind to include "${expectedKind}", got ${JSON.stringify(kinds)}`,
      ).toContain(expectedKind);

      for (const k of kinds) seenKinds.add(k);
    }

    // Sanity: across the case set we should have observed all four Plan-3
    // profile-failure-kind discriminators. This guards against a future
    // regression where two cases accidentally collapse to the same kind.
    expect(seenKinds).toContain("ref");
    expect(seenKinds).toContain("cycle");
    expect(seenKinds).toContain("schema");
    expect(seenKinds).toContain("interp");
  });
});
