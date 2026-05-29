import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

let projectPath: string | null = null;
let projectCleanup: (() => void) | null = null;
let lichHome: string | null = null;
let apiPort: number | null = null;

function parseUrls(stdout: string): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(
      /^(\S+):\s+http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\s*\/?\s*$/,
    );
    if (!m) continue;
    const [, key, portStr] = m;
    if (key.includes(".")) continue;
    ports[key] = Number(portStr);
  }
  return ports;
}

describe("lich logs filtering", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      execSync("bun run build", {
        cwd: join(repoRoot, "packages/lich"),
        stdio: "inherit",
      });

      const copied = copyExampleToTmpdir("dogfood-stack");
      projectPath = copied.path;
      projectCleanup = copied.cleanup;

      lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-logs-home-"));

      execSync("bun install", { cwd: projectPath, stdio: "inherit" });

      const upResult = runLich(["up"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 180_000,
      });
      if (upResult.exitCode !== 0) {
        throw new Error(
          `lich up failed (exit ${upResult.exitCode})\n` +
            `--- stdout ---\n${upResult.stdout}\n` +
            `--- stderr ---\n${upResult.stderr}`,
        );
      }

      const urlsResult = runLich(["urls", "--raw"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsResult.exitCode).toBe(0);
      const ports = parseUrls(urlsResult.stdout);
      if (typeof ports.api !== "number") {
        throw new Error(
          `could not find api port in lich urls output:\n${urlsResult.stdout}`,
        );
      }
      apiPort = ports.api;

      await waitForHttp200(`http://localhost:${apiPort}/health`, {
        timeoutMs: 30_000,
      });
      await expectDbMode(`http://localhost:${apiPort}`, "stub");

      // generate a few request log lines beyond the startup banner
      for (let i = 0; i < 3; i++) {
        await fetch(`http://localhost:${apiPort}/health`).catch(() => {
          /* tolerate transient errors */
        });
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    },
    180_000,
  );

  it(
    "aggregates all services and prefixes each line with [service]",
    () => {
      const result = runLich(["logs", "--count", "50"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      });
      expect(result.exitCode).toBe(0);

      expect(result.stdout).toContain("[api]");
      expect(result.stdout).toContain("[web]");
    },
  );

  it(
    "filters to a single service and omits the [service] prefix",
    () => {
      const result = runLich(["logs", "api", "--count", "50"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      // No `[<svc>]` prefix when filtering; api's own [api] in body content is OK
      expect(result.stdout).not.toMatch(/^\[web\] /m);
    },
  );

  it(
    "limits initial output via --count N",
    () => {
      const result = runLich(["logs", "api", "--count", "1"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      });
      expect(result.exitCode).toBe(0);
      // Content lines only (not footer lines)
      const lines = result.stdout.split("\n").filter(
        (l) => l.length > 0 && !l.startsWith("Showing") && !l.startsWith("Older") && !l.startsWith("Newer") && !l.startsWith("Full"),
      );
      expect(lines.length).toBeLessThanOrEqual(1);
    },
  );

  it(
    "exits promptly after printing existing content (non-follow by default)",
    () => {
      const start = Date.now();
      const result = runLich(["logs", "--count", "10"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      });
      const elapsed = Date.now() - start;

      expect(result.exitCode).toBe(0);
      // Should be sub-second; 3s tolerates cold binary spawn
      expect(elapsed).toBeLessThan(3_000);
    },
  );

  it(
    "contains api content after the api has handled a request",
    () => {
      const result = runLich(["logs", "api", "--count", "50"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      });
      expect(result.exitCode).toBe(0);
      // pin the api's startup banner line from apps/api/src/index.ts
      expect(result.stdout).toMatch(/listening on http:\/\/localhost:/);
    },
  );

  it(
    "exits non-zero and lists available services for an unknown name",
    () => {
      const result = runLich(
        ["logs", "definitely-not-a-real-service"],
        {
          cwd: projectPath!,
          env: { LICH_HOME: lichHome! },
          timeout: 5_000,
        },
      );

      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined.toLowerCase()).toContain("definitely-not-a-real-service");
      expect(combined).toMatch(/api|web/);
    },
  );

  it(
    "(teardown) nuke + remove tmpdirs",
    async () => {
      if (lichHome) {
        try {
          spawnSync(LICH_BINARY, ["nuke", "--yes"], {
            cwd: projectPath ?? process.cwd(),
            env: { ...process.env, LICH_HOME: lichHome },
            timeout: 90_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
      }

      if (projectCleanup) {
        try {
          projectCleanup();
        } catch {
          /* best-effort */
        }
      }
      if (lichHome && existsSync(lichHome)) {
        try {
          rmSync(lichHome, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }

      projectPath = null;
      projectCleanup = null;
      lichHome = null;
      apiPort = null;
    },
    120_000,
  );
});
