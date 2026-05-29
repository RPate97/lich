import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

interface Fixture {
  stackPath: string;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(yaml: string): Fixture {
  const stackPath = mkdtempSync(join(tmpdir(), "lich-e2e-env-unset-"));
  writeFileSync(join(stackPath, "lich.yaml"), yaml, "utf8");
  const lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-env-unset-home-"));
  return { stackPath, lichHome };
}

afterEach(() => {
  if (!fixture) return;
  try {
    rmSync(fixture.stackPath, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown stackPath cleanup failed:`, err);
  }
  try {
    rmSync(fixture.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown lichHome cleanup failed:`, err);
  }
  fixture = null;
});

describe("env: { VAR: null } unsets an inherited var", () => {
  // CANARY is the load-bearing case; KEEP is the sanity sibling.
  const yaml = [
    'version: "1"',
    "env:",
    "  CANARY: null",
    '  KEEP: "still-here"',
    "",
  ].join("\n");

  it("lich exec does NOT see CANARY in the spawned child's env (parent shell set CANARY)", () => {
    fixture = makeFixture(yaml);
    // printenv exits 0 if key present (even empty), nonzero if absent.
    // We need absent, not empty — the contract is no key, not key=""
    const result = runLich(
      [
        "exec",
        "--",
        "sh",
        "-c",
        'printenv CANARY > /dev/null && echo HAS || echo NONE',
      ],
      {
        cwd: fixture.stackPath,
        env: {
          LICH_HOME: fixture.lichHome,
          CANARY: "parent-value",
          KEEP: "still-here",
        },
      },
    );
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("NONE");
  });

  it("sibling keys not nulled by yaml still flow through (sanity)", () => {
    fixture = makeFixture(yaml);
    const result = runLich(
      ["exec", "--", "sh", "-c", "echo KEEP=$KEEP"],
      {
        cwd: fixture.stackPath,
        env: {
          LICH_HOME: fixture.lichHome,
          CANARY: "parent-value",
          KEEP: "still-here",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("KEEP=still-here");
  });

  it("lich env stack output omits the nulled key from the dotenv", () => {
    fixture = makeFixture(yaml);
    const result = runLich(["env", "stack"], {
      cwd: fixture.stackPath,
      env: {
        LICH_HOME: fixture.lichHome,
        CANARY: "parent-value",
      },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/^CANARY=/m);
    expect(result.stdout).toMatch(/^KEEP=/m);
  });
});
