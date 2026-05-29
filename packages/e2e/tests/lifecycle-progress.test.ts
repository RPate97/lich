import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import {
  LICH_BINARY as lichBinary,
  REPO_ROOT as repoRoot,
} from "@/helpers/paths.js";

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

describe("lifecycle per-hook progress (LEV-495)", () => {
  it(
    "before_up with 3 entries: each entry's start + complete lines appear in order with a per-entry timer",
    () => {
      const dir = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-"),
      );
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-home-"),
      );

      // 3 entries of varying length. The sleeps keep the elapsed timer
      // observable (0.1s/0.2s/0.3s) but well under any test timeout.
      // Each cmd's first word ("echo") makes assertion matching easier
      // since the renderer uses the first line of the cmd.
      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_up:
    - "echo entry-a; sleep 0.1"
    - "echo entry-b; sleep 0.2"
    - "echo entry-c; sleep 0.3"
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

        const out = upResult.stdout;

        expect(out).toContain("▶ before_up (1/3): echo entry-a; sleep 0.1");
        expect(out).toContain("▶ before_up (2/3): echo entry-b; sleep 0.2");
        expect(out).toContain("▶ before_up (3/3): echo entry-c; sleep 0.3");

        expect(out).toMatch(/✓ before_up \(1\/3\) — \d+\.\d+s/);
        expect(out).toMatch(/✓ before_up \(2\/3\) — \d+\.\d+s/);
        expect(out).toMatch(/✓ before_up \(3\/3\) — \d+\.\d+s/);

        // strict interleaving: start→complete→start→complete...
        const startA = out.indexOf("▶ before_up (1/3):");
        const completeA = out.indexOf("✓ before_up (1/3)");
        const startB = out.indexOf("▶ before_up (2/3):");
        const completeB = out.indexOf("✓ before_up (2/3)");
        const startC = out.indexOf("▶ before_up (3/3):");
        const completeC = out.indexOf("✓ before_up (3/3)");
        expect(startA).toBeGreaterThan(-1);
        expect(completeA).toBeGreaterThan(-1);
        expect(startB).toBeGreaterThan(-1);
        expect(completeB).toBeGreaterThan(-1);
        expect(startC).toBeGreaterThan(-1);
        expect(completeC).toBeGreaterThan(-1);
        expect(startA).toBeLessThan(completeA);
        expect(completeA).toBeLessThan(startB);
        expect(startB).toBeLessThan(completeB);
        expect(completeB).toBeLessThan(startC);
        expect(startC).toBeLessThan(completeC);

        expect(out).toMatch(/✓ before_up — \d+\.\d+s/);
        const phaseSummary = out.search(/✓ before_up — \d+\.\d+s/);
        expect(phaseSummary).toBeGreaterThan(completeC);
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
    "lich up with --json: emits lifecycle_entry_start + lifecycle_entry_complete events per entry",
    () => {
      const dir = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-json-"),
      );
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-json-home-"),
      );

      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_up:
    - "echo json-a"
    - "echo json-b"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        const upResult = runLich(["up", "--no-browser", "--json"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up json stdout:\n" + upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up json stderr:\n" + upResult.stderr);
        }
        expect(upResult.exitCode).toBe(0);

        // Parse the NDJSON stream. Some lines may be from other surfaces
        // (phase_begin, summary, etc.); filter to lifecycle entry events
        // only.
        const events: Array<Record<string, unknown>> = [];
        for (const line of upResult.stdout.split("\n")) {
          if (line === "") continue;
          try {
            events.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // Non-JSON lines (e.g. info banner) can sneak in; skip.
          }
        }
        const lifecycleEvents = events.filter(
          (e) =>
            e.type === "lifecycle_entry_start" ||
            e.type === "lifecycle_entry_complete",
        );

        // 2 entries × {start, complete} = 4 events.
        expect(lifecycleEvents).toHaveLength(4);

        // start_a, complete_a, start_b, complete_b ordering.
        expect(lifecycleEvents[0]).toMatchObject({
          type: "lifecycle_entry_start",
          phase: "before_up",
          index: 0,
          total: 2,
          cmd: "echo json-a",
        });
        expect(lifecycleEvents[1]).toMatchObject({
          type: "lifecycle_entry_complete",
          phase: "before_up",
          index: 0,
          total: 2,
          cmd: "echo json-a",
          exit_code: 0,
        });
        // elapsed_ms is timing-dependent; assert presence + non-negativity.
        expect(typeof lifecycleEvents[1].elapsed_ms).toBe("number");
        expect(lifecycleEvents[1].elapsed_ms as number).toBeGreaterThanOrEqual(
          0,
        );

        expect(lifecycleEvents[2]).toMatchObject({
          type: "lifecycle_entry_start",
          phase: "before_up",
          index: 1,
          total: 2,
          cmd: "echo json-b",
        });
        expect(lifecycleEvents[3]).toMatchObject({
          type: "lifecycle_entry_complete",
          phase: "before_up",
          index: 1,
          total: 2,
          cmd: "echo json-b",
          exit_code: 0,
        });
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
    "lich down with multi-entry before_down: per-entry start + complete lines appear",
    () => {
      // Symmetric coverage on down so LEV-496 (in flight) can build on
      // top without re-establishing the per-entry contract for teardown.
      const dir = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-down-"),
      );
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-lifecycle-progress-down-home-"),
      );

      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "echo down-a"
    - "echo down-b"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        expect(upResult.exitCode).toBe(0);

        const downResult = runLich(["down"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 30_000,
        });
        expect(downResult.exitCode).toBe(0);

        const out = downResult.stdout;
        expect(out).toContain("▶ before_down (1/2): echo down-a");
        expect(out).toContain("▶ before_down (2/2): echo down-b");
        expect(out).toMatch(/✓ before_down \(1\/2\) — \d+\.\d+s/);
        expect(out).toMatch(/✓ before_down \(2\/2\) — \d+\.\d+s/);

        // Ordering: each start precedes its complete; entry A finishes
        // before entry B starts.
        const startA = out.indexOf("▶ before_down (1/2):");
        const completeA = out.indexOf("✓ before_down (1/2)");
        const startB = out.indexOf("▶ before_down (2/2):");
        const completeB = out.indexOf("✓ before_down (2/2)");
        expect(startA).toBeLessThan(completeA);
        expect(completeA).toBeLessThan(startB);
        expect(startB).toBeLessThan(completeB);
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
