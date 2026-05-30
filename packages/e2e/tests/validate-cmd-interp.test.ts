import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot, DOGFOOD_STACK as dogfoodStack } from "@/helpers/paths.js";

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

describe("lich validate — cmd-context interpolation", () => {
  it("rejects a dangling ${owned.X.port} ref across env, lifecycle, and commands surfaces", () => {
    const result = runLich(["validate", "cmd-dangling-ref.yaml"], {
      cwd: fixturesDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/owned/api/env/SERVER_URL");
    expect(result.stderr).toContain("serverr");
    expect(result.stderr).toContain("/lifecycle/after_up/0");
    expect(result.stderr).toContain("bogus");
    expect(result.stderr).toContain("/commands/show/cmd");
    expect(result.stderr).toMatch(/unknown owned service/);
  });

  it("--json reports every cmd-context interp error with kind 'interp'", () => {
    interface JsonReport {
      ok: boolean;
      path: string;
      errors?: Array<{ kind: string; location: string; message: string }>;
    }
    const result = runLich(["validate", "--json", "cmd-dangling-ref.yaml"], {
      cwd: fixturesDir,
    });
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.ok).toBe(false);

    const interpErrors = (report.errors ?? []).filter((e) => e.kind === "interp");
    expect(interpErrors.length).toBeGreaterThanOrEqual(3);

    const locations = interpErrors.map((e) => e.location).join(" | ");
    expect(locations).toContain("/owned/api/env/SERVER_URL");
    expect(locations).toContain("/lifecycle/after_up/0");
    expect(locations).toContain("/commands/show/cmd");
  });

  it("dogfood-stack lich.yaml still validates cleanly with the extended checks", () => {
    const result = runLich(["validate", resolve(dogfoodStack, "lich.yaml")], {
      cwd: dogfoodStack,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
