import { beforeAll, describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
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

let workDir: string | null = null;
let lichHome: string | null = null;

afterEach(() => {
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    workDir = null;
  }
  if (lichHome) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    lichHome = null;
  }
});

describe("lich feedback — deep-link path (LEV-508)", () => {
  it(
    "prints a pre-filled GitHub issue URL and caches the payload",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "lich-e2e-feedback-deep-link-"));
      lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-feedback-home-"));

      const result = runLich(
        ["feedback", "short test message about a bug", "--yes", "--no-browser"],
        {
          cwd: workDir,
          env: { LICH_HOME: lichHome },
          timeout: 15_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "To submit, open this pre-filled GitHub issue:",
      );
      expect(result.stdout).toContain(
        "https://github.com/RPate97/lich/issues/new?",
      );
      expect(result.stdout).toMatch(/[?&]title=feedback%3A\+short\+test\+message/);
      expect(result.stdout).toMatch(/[?&]body=%23%23\+Message/);
      expect(result.stdout).toMatch(/[?&]labels=feedback\b/);

      const feedbackDir = join(lichHome, "feedback");
      expect(existsSync(feedbackDir)).toBe(true);
      const cached = readdirSync(feedbackDir);
      expect(cached.length).toBeGreaterThanOrEqual(1);
      expect(cached.some((f) => f.endsWith(".md"))).toBe(true);
    },
    30_000,
  );

  it(
    "LICH_NO_BROWSER=1 suppresses the browser open the same way as --no-browser",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "lich-e2e-feedback-deep-link-env-"));
      lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-feedback-home-env-"));

      const result = runLich(["feedback", "another short message", "--yes"], {
        cwd: workDir,
        env: { LICH_HOME: lichHome, LICH_NO_BROWSER: "1" },
        timeout: 15_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "https://github.com/RPate97/lich/issues/new?",
      );
      expect(result.stdout).toContain("&labels=feedback");
    },
    30_000,
  );
});
