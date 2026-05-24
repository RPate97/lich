/**
 * E2E tests for `lich validate` Plan 4 regex / duration error paths
 * (LEV-374, Task 25 — the e2e analog of the unit tests for `checkRegexes`
 * and `ready_when.timeout` schema tightening).
 *
 * Drives the real compiled `lich` binary against a directory of intentionally
 * malformed YAML fixtures and asserts the three failure modes Plan 4 added:
 *
 *   1. Bad regex in `owned.<name>.fail_when.log_match` — surfaces as a
 *      `kind: "regex"` ValidationError pointing at the
 *      `/owned/<name>/fail_when/log_match` location.
 *   2. Bad regex in `owned.<name>.ready_when.capture.<key>` — surfaces as a
 *      `kind: "regex"` ValidationError pointing at the
 *      `/owned/<name>/ready_when/capture/<key>` location (Task 13 wired this).
 *   3. Malformed `ready_when.timeout: "forever"` — surfaces as a
 *      `kind: "schema"` ValidationError from ajv (Task 5 tightened the
 *      schema; the runtime parser's grammar matches).
 *
 * Why static fixtures rather than copy-the-dogfood-stack + inject:
 *   - `lich validate` is pure config parsing; copying the whole stack adds
 *     I/O + cleanup with no validation-time signal. The acceptance criteria
 *     name "copy + inject" as one possible recipe; the implementation note
 *     ("Run `lich validate` via `runLich` (sync) — no need for spawn")
 *     points at the simpler static-fixtures path that matches the existing
 *     `validate-plan2-errors.test.ts` pattern.
 *   - Static fixtures keep each test under a second and let the suite stay
 *     hermetic — the failures we care about live in three small `owned`
 *     blocks, not the surrounding env / lifecycle / profile scaffolding.
 *   - The fixtures are dogfood-shaped (api with cmd/port/ready_when, tunnel
 *     with the same capture pattern from Task 19's `tunnel_demo`) so the
 *     test still exercises the realistic shape of the user-facing config.
 *
 * Output routing — locked by the binary probe before writing these tests:
 *   - Pretty output for `!ok` reports goes to STDERR (the validate command
 *     swaps `out → err` for the error sink).
 *   - JSON output always goes to STDOUT (regardless of `ok`).
 *
 * Speed: pure config — no `lich up`, no docker, no supabase. Each test
 * should finish well under a second.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as basic-up.test.ts and
// validate-plan2-errors.test.ts: the binary IS our code, so a broken build
// should fail loudly rather than be skipped. No-op when dist/lich already
// exists.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");
const fixturesDir = resolve(import.meta.dir, "fixtures/invalid-yamls");

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

describe("lich validate — Plan 4 regex / duration error paths", () => {
  // -------------------------------------------------------------------------
  // 1. Bad regex in fail_when.log_match
  // -------------------------------------------------------------------------
  it("catches a malformed regex in owned.<name>.fail_when.log_match (bad-regex-fail-when.yaml)", () => {
    const result = runLich(["validate", "bad-regex-fail-when.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // Pretty error output for `!ok` lands on stderr. The exact message shape
    // comes from `tryCompile` in `commands/validate.ts` — "invalid regex
    // /<pattern>/: <engine message>".
    expect(result.stderr).toContain("invalid regex");
    // The bad pattern must appear in the message so the user can grep their
    // yaml — same UX contract as the unit-level coverage in
    // packages/lich/tests/unit/config/validate-capture-regex.test.ts.
    expect(result.stderr).toContain("[invalid(");
    // The location must be the JSON-pointer-style path to the offending
    // field. Substring (not equality) so the absolute fixtures path doesn't
    // make the assertion brittle on different machines.
    expect(result.stderr).toContain("/owned/api/fail_when/log_match");
  });

  // -------------------------------------------------------------------------
  // 2. Bad regex in ready_when.capture
  // -------------------------------------------------------------------------
  it("catches a malformed regex in owned.<name>.ready_when.capture.<key> (bad-regex-capture.yaml)", () => {
    const result = runLich(["validate", "bad-regex-capture.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid regex");
    expect(result.stderr).toContain("[invalid(");
    // The location must include both the owned service name AND the capture
    // key so the user can jump straight to the offending line. This is the
    // load-bearing assertion for Task 13's location-format contract.
    expect(result.stderr).toContain("/owned/tunnel/ready_when/capture/url");
  });

  // -------------------------------------------------------------------------
  // 3. Malformed ready_when.timeout — schema error from ajv
  // -------------------------------------------------------------------------
  it("rejects ready_when.timeout: 'forever' as a schema error (bad-timeout-forever.yaml)", () => {
    const result = runLich(["validate", "bad-timeout-forever.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // The schema's duration pattern (`^[0-9]+(ms|s|m|h)?$`) rejects
    // "forever". The ajv error chain for a `oneOf` failure surfaces three
    // lines (pattern mismatch + type mismatch + overall oneOf failure); we
    // assert on the pattern variant because it's the most diagnostic for
    // the user — it points them at the supported grammar.
    expect(result.stderr).toContain("/owned/api/ready_when/timeout");
    expect(result.stderr).toContain("[0-9]+(ms|s|m|h)?");
  });

  // -------------------------------------------------------------------------
  // 4. --json shape across all three failure categories
  // -------------------------------------------------------------------------
  //
  // Parallel to the `--json` test in validate-plan2-errors.test.ts: drive
  // each fixture with `--json` and assert the structured report carries the
  // expected `errors[].kind` discriminator. This is the load-bearing
  // assertion for any downstream tooling that consumes `lich validate
  // --json` (CI dashboards, editor extensions) on Plan 4 surfaces.
  // -------------------------------------------------------------------------
  it("--json emits the expected errors[].kind across the regex / regex / schema fixtures", () => {
    interface JsonReport {
      ok: boolean;
      path: string;
      errors?: Array<{ kind: string; location: string; message: string }>;
    }

    const cases: Array<{
      fixture: string;
      expectedKind: string;
      expectedLocSubstring: string;
    }> = [
      {
        fixture: "bad-regex-fail-when.yaml",
        expectedKind: "regex",
        expectedLocSubstring: "/owned/api/fail_when/log_match",
      },
      {
        fixture: "bad-regex-capture.yaml",
        expectedKind: "regex",
        expectedLocSubstring: "/owned/tunnel/ready_when/capture/url",
      },
      {
        fixture: "bad-timeout-forever.yaml",
        expectedKind: "schema",
        expectedLocSubstring: "bad-timeout-forever.yaml",
      },
    ];

    for (const { fixture, expectedKind, expectedLocSubstring } of cases) {
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
          `failed to parse JSON report for ${fixture}: ${(e as Error).message}\n` +
            `stdout was: ${result.stdout}\nstderr was: ${result.stderr}`,
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

      // At least one error of the expected kind should point at the right
      // location. Substring match keeps the test portable across machines
      // where the absolute fixtures path differs.
      const matching = report.errors!.filter(
        (e) =>
          e.kind === expectedKind && e.location.includes(expectedLocSubstring),
      );
      expect(
        matching.length,
        `${fixture}: expected at least one ${expectedKind} error whose location contains "${expectedLocSubstring}", got ${JSON.stringify(report.errors)}`,
      ).toBeGreaterThan(0);
    }
  });
});
