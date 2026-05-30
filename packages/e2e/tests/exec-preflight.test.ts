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
  const stackPath = mkdtempSync(join(tmpdir(), "lich-e2e-exec-preflight-"));
  writeFileSync(join(stackPath, "lich.yaml"), yaml, "utf8");
  const lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-exec-preflight-home-"));
  return { stackPath, lichHome };
}

afterEach(() => {
  if (!fixture) return;
  try {
    rmSync(fixture.stackPath, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fixture.lichHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  fixture = null;
});

describe("lich exec — preflight stack-up check (LEV-537)", () => {
  it("warns on stderr when no stack has ever been brought up, command still runs", () => {
    fixture = makeFixture(`version: "1"\nenv:\n  CANARY: ok\n`);
    const result = runLich(["exec", "--", "echo", "hello-from-exec"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-from-exec");
    expect(result.stderr).toContain("[lich] warning");
    expect(result.stderr).toContain("no lich stack in this worktree");
  });

  it("--no-preflight suppresses the warning entirely", () => {
    fixture = makeFixture(`version: "1"\n`);
    const result = runLich(
      ["exec", "--no-preflight", "--", "echo", "quiet"],
      { cwd: fixture.stackPath, env: { LICH_HOME: fixture.lichHome } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("quiet");
    expect(result.stderr).not.toContain("warning");
  });

  it("preserves the child's exit code even when warning is printed", () => {
    fixture = makeFixture(`version: "1"\n`);
    const result = runLich(["exec", "sh -c 'exit 42'"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
    });
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toContain("[lich] warning");
  });
});
