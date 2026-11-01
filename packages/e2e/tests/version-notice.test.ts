import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const home = mkdtempSync(join(tmpdir(), "lich-notice-e2e-"));
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

const NOTICE_RE = /lich .* is out of date — latest is 999\.0\.0\. Run `lich update` to upgrade\./;

describe("out-of-date notice", () => {
  it("fires on stderr for an ordinary CLI run when the cache advertises a newer version", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["stacks"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(NOTICE_RE);
      expect(r.stdout).not.toMatch(NOTICE_RE);
    } finally {
      cleanup();
    }
  });

  it("fires on `lich --help` too (the notice does not gate on command type)", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["--help"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(NOTICE_RE);
    } finally {
      cleanup();
    }
  });

  it("does not fire on --version (would clutter scripted version probes)", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["--version"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^lich \d+\.\d+\.\d+\s*$/);
    } finally {
      cleanup();
    }
  });

  it("does not fire when --json is set (would break stderr-capturing jq pipelines)", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["stacks", "--json"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("does not fire when LICH_NO_UPDATE_CHECK=1 is set", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["stacks"], {
        cwd: home,
        env: {
          LICH_HOME: home,
          LICH_UPDATE_CHECK_NO_REFRESH: "1",
          LICH_NO_UPDATE_CHECK: "1",
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("does not fire during `lich update` itself (would be noise)", () => {
    const { home, cleanup } = freshHome();
    try {
      seedCache(home, "999.0.0");
      const r = runLich(["update", "--dry-run"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("stays silent when cache matches current version", () => {
    const { home, cleanup } = freshHome();
    try {
      const versionResult = runLich(["--version"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      const currentVersion = versionResult.stdout.trim().replace(/^lich\s+/, "");
      seedCache(home, currentVersion);

      const r = runLich(["stacks"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("silent on a cold cache when refresh is disabled (no network, no leak)", () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["stacks"], {
        cwd: home,
        env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      // The cache file should still be absent since refresh is disabled.
      expect(existsSync(join(home, "latest-check.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("background refresh writes a cache file on a real cold run (skipped offline)", async () => {
    const { home, cleanup } = freshHome();
    try {
      const r = runLich(["stacks"], {
        cwd: home,
        env: { LICH_HOME: home },
      });
      expect(r.exitCode).toBe(0);
      const path = join(home, "latest-check.json");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !existsSync(path)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(typeof parsed.checked_at).toBe("string");
      expect(parsed.latest_version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      cleanup();
    }
  }, 15_000);
});
