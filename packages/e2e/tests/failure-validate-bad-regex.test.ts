import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

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

describe("lich validate — regex / duration error paths", () => {
  it("catches a malformed regex in owned.<name>.fail_when.log_match (bad-regex-fail-when.yaml)", () => {
    const result = runLich(["validate", "bad-regex-fail-when.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid regex");
    expect(result.stderr).toContain("[invalid(");
    expect(result.stderr).toContain("/owned/api/fail_when/log_match");
  });

  it("catches a malformed regex in owned.<name>.ready_when.capture.<key> (bad-regex-capture.yaml)", () => {
    const result = runLich(["validate", "bad-regex-capture.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid regex");
    expect(result.stderr).toContain("[invalid(");
    expect(result.stderr).toContain("/owned/tunnel/ready_when/capture/url");
  });

  it("rejects ready_when.timeout: 'forever' as a schema error (bad-timeout-forever.yaml)", () => {
    const result = runLich(["validate", "bad-timeout-forever.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    // assert on pattern variant — most diagnostic for the user
    expect(result.stderr).toContain("/owned/api/ready_when/timeout");
    expect(result.stderr).toContain("[0-9]+(ms|s|m|h)?");
  });

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
