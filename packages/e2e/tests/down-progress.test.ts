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

describe("lich down progress output", () => {
  it(
    "shows per-service progress + lifecycle hook segments + total elapsed",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-down-progress-"));
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-down-progress-home-"),
      );

      // 3 services with depends_on edges; teardown is reverse-topo (c→b→a)
      const yaml = `version: "1"
runtime:
  port_range: [19900, 19999]
owned:
  a:
    cmd: "sleep 60"
  b:
    cmd: "sleep 60"
    depends_on: [a]
  c:
    cmd: "sleep 60"
    depends_on: [b]
lifecycle:
  before_down:
    - "true"
  after_down:
    - "true"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up stdout:\n" + upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up stderr:\n" + upResult.stderr);
        }
        expect(upResult.exitCode).toBe(0);

        // Non-TTY pretty emits one `▶ <phase>` line per begin/update
        const downResult = runLich(["down"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 30_000,
        });
        if (downResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich down stdout:\n" + downResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich down stderr:\n" + downResult.stderr);
        }
        expect(downResult.exitCode).toBe(0);

        const stdout = downResult.stdout;

        const ownedProgressLines = stdout
          .split("\n")
          .filter((l) =>
            l.includes("down: stopping owned services"),
          );
        expect(
          ownedProgressLines.length,
          `expected at least 3 owned-progress lines, got ${ownedProgressLines.length}:\n${stdout}`,
        ).toBeGreaterThanOrEqual(3);

        expect(stdout).toContain("stopping owned services (1/3:");
        expect(stdout).toContain("stopping owned services (2/3:");
        expect(stdout).toContain("stopping owned services (3/3:");

        expect(stdout).toMatch(
          /✓ down: stopping owned services .* — stopped owned services \(3\/3\) — \d+\.\d+s/,
        );

        expect(stdout).toContain("down: running before_down hooks (1/1)");
        expect(stdout).toMatch(
          /✓ down: running before_down hooks \(1\/1\) — hooks done — \d+\.\d+s/,
        );
        expect(stdout).toContain("down: running after_down hooks (1/1)");
        expect(stdout).toMatch(
          /✓ down: running after_down hooks \(1\/1\) — hooks done — \d+\.\d+s/,
        );

        expect(stdout).toMatch(/stack down: \S+ — \d+\.\d+s/);

        expect(stdout).not.toMatch(/warning\(s\) during teardown/i);
      } finally {
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
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
    },
    90_000,
  );

  it(
    "emits NDJSON progress events under --json (machine-readable surface)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-down-json-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-down-json-home-"));

      const yaml = `version: "1"
runtime:
  port_range: [19900, 19999]
owned:
  a:
    cmd: "sleep 60"
  b:
    cmd: "sleep 60"
    depends_on: [a]
lifecycle:
  before_down:
    - "true"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up stdout:\n" + upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up stderr:\n" + upResult.stderr);
        }
        expect(upResult.exitCode).toBe(0);

        const downResult = runLich(["down", "--json"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 30_000,
        });
        if (downResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich down --json stdout:\n" + downResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich down --json stderr:\n" + downResult.stderr);
        }
        expect(downResult.exitCode).toBe(0);

        const events: Array<Record<string, unknown>> = [];
        for (const line of downResult.stdout.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          if (!trimmed.startsWith("{")) continue;
          try {
            events.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            /* skip malformed */
          }
        }

        const begins = events
          .filter((e) => e.type === "phase_begin")
          .map((e) => e.name as string);
        expect(begins.length).toBeGreaterThanOrEqual(2);
        expect(begins[0]).toMatch(/stopping owned services \(1\/2:/);
        expect(begins.some((n) => /running before_down hooks/.test(n))).toBe(
          true,
        );

        const ownedUpdates = events.filter(
          (e) =>
            e.type === "phase_update" &&
            typeof e.name === "string" &&
            (e.name as string).includes("stopping owned services"),
        );
        expect(ownedUpdates.length).toBe(1);
        expect((ownedUpdates[0]!.name as string)).toContain("(2/2:");

        const summary = events.find((e) => e.type === "summary");
        expect(summary).toBeDefined();
        expect(typeof (summary!.elapsed_ms as number)).toBe("number");
        expect((summary!.title as string).startsWith("stack down:")).toBe(
          true,
        );
      } finally {
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
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
    },
    90_000,
  );
});
