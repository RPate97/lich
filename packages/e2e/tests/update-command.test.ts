import { beforeAll, describe, expect, it } from "vitest";
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
    throw new Error(`failed to build lich binary (exit ${build.status})`);
  }
});

function freshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "lich-update-e2e-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function seedCache(home: string, latest: string): void {
  writeFileSync(
    join(home, "latest-check.json"),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      latest_version: latest,
    }),
  );
}

describe("lich update", () => {
  it("shows up as a built-in in `lich --help`", () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["--help"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^\s{2}update\b/m);
      expect(r.stdout).toContain("Upgrade the lich binary");
    } finally {
      cleanup();
    }
  });

  it("`lich update --help` prints the usage section", () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["update", "--help"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Usage: lich update");
      expect(r.stdout).toContain("--check");
      expect(r.stdout).toContain("--dry-run");
    } finally {
      cleanup();
    }
  });

  it("--dry-run prints the planned install one-liner and does not install", () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["update", "--dry-run"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("curl -fsSL https://lich.sh/install.sh");
      expect(r.stdout).toContain("bash");
    } finally {
      cleanup();
    }
  });

  it("--dry-run with a version argument embeds LICH_VERSION in the command", () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["update", "v0.4.0", "--dry-run"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("LICH_VERSION=v0.4.0");
    } finally {
      cleanup();
    }
  });

  it("--check with a seeded cache reports up-to-date (binary's own version)", () => {
    const { home, cleanup } = freshHome();
    try {
      const versionResult = runLich(["--version"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(versionResult.exitCode).toBe(0);
      const currentVersion = versionResult.stdout.trim().replace(/^lich\s+/, "");
      seedCache(home, currentVersion);

      const r = runLich(["update", "--check"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("up to date");
    } finally {
      cleanup();
    }
  });

  it("--check with a seeded cache reports out-of-date when cache advertises a newer version", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["update", "--check"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("latest:  999.0.0");
      expect(r.stdout).toContain("out of date");
    } finally {
      cleanup();
    }
  });
});
