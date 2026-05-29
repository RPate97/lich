import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { parseLichUrls } from "../helpers/urls.js";
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
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

interface StacksJsonEntry {
  stack_id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services?: Array<{ name: string; state: string }>;
}

describe("lich up activates the default profile", () => {
  it(
    "(setup) brings the dogfood-stack up with no profile arg",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-default-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // no positional → resolver picks the default-marked profile
      const upResult = runLich(["up", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 120_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with default-profile assertion`,
        );
      }

      // verify db: "stub" — catches profile drift earlier than active_profile assertion below
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
    },
    180_000,
  );

  it("lich stacks --json reports active_profile === 'dev:fast'", () => {
    const fix = fixture!;

    const result = runLich(["stacks", "--json"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    let parsed: StacksJsonEntry[];
    try {
      parsed = JSON.parse(result.stdout) as StacksJsonEntry[];
    } catch (err) {
      throw new Error(
        `lich stacks --json did not return valid JSON.\n` +
          `--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}\n` +
          `--- parse error ---\n${(err as Error).message}`,
      );
    }
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const entry = parsed[0];
    expect(entry.status, `stack status from stacks --json: ${JSON.stringify(entry)}`).toBe("up");

    expect(entry.active_profile).toBe("dev:fast");

    const serviceNames = (entry.services ?? []).map((s) => s.name).sort();
    expect(serviceNames).toEqual(["api", "web"]);
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 20_000,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown lich nuke failed:", err);
      }
      try {
        fixture.stackCleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown tmpdir cleanup failed:", err);
      }
      try {
        rmSync(fixture.lichHome, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    60_000,
  );
});

describe("lich up errors when no default profile is set", () => {
  it("exits non-zero with output containing 'no default profile' when no arg given", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-no-default-"));
    const home = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-no-default-home-"));

    try {
      // Two profiles, neither defaulting
      const yaml = [
        'version: "1"',
        "",
        "profiles:",
        "  a: {}",
        "  b: {}",
        "",
      ].join("\n");
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["up"], {
        cwd: dir,
        env: { LICH_HOME: home },
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `combined output:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ).not.toBe(0);

      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      expect(combined).toContain("no default profile");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
