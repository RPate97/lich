import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
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
});

interface StacksJsonEntry {
  stack_id: string;
  worktree_name: string;
  status: string;
  started_at: string;
  uptime_seconds: number;
  services: Array<{ name: string; kind: string; state: string }>;
  primary_url?: string;
  active_profile?: string;
  lifecycle?: Record<string, unknown>;
}

interface ParsedTableRow {
  worktree: string;
  status: string;
  uptime: string;
  services: string;
  url: string;
}

function parseTable(text: string): ParsedTableRow[] {
  const lines = text.trimEnd().split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(/\s{2,}/).map((s) => s.trim());
    return {
      worktree: cells[0] ?? "",
      status: cells[1] ?? "",
      uptime: cells[2] ?? "",
      services: cells[3] ?? "",
      url: cells[4] ?? "",
    };
  });
}

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

afterAll(() => {
  if (!fixture) return;
  try {
    runLich(["down"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 30_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    fixture.stackCleanup();
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

describe("lich stacks — table and --json parity (LEV-532)", () => {
  it(
    "after a real `lich up`, table fields are derivable from the JSON output",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-stacks-parity-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      const upResult = runLich(["up", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 120_000,
      });
      expect(upResult.exitCode, `lich up failed:\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`).toBe(0);

      // Same stack, back-to-back: any drift between renderers will be observable.
      const tableResult = runLich(["stacks"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      expect(tableResult.exitCode).toBe(0);

      const jsonResult = runLich(["stacks", "--json"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 10_000,
      });
      expect(jsonResult.exitCode).toBe(0);

      const tableRows = parseTable(tableResult.stdout);
      const jsonRows = JSON.parse(jsonResult.stdout) as StacksJsonEntry[];

      expect(tableRows.length).toBe(jsonRows.length);
      expect(tableRows.length).toBeGreaterThanOrEqual(1);

      // Match by worktree_name (both sort by it, so positions align).
      const jsonByWt = new Map(jsonRows.map((r) => [r.worktree_name, r]));
      for (const tRow of tableRows) {
        const jRow = jsonByWt.get(tRow.worktree);
        expect(jRow, `JSON has no entry for table row ${tRow.worktree}`).toBeDefined();
        if (!jRow) continue;

        // Status base must match (table may add a `(phase i/n: cmd)` suffix on failure).
        expect(
          tRow.status.startsWith(jRow.status),
          `table status '${tRow.status}' doesn't start with json status '${jRow.status}'`,
        ).toBe(true);

        // URL column == JSON primary_url (or blank).
        expect(tRow.url).toBe(jRow.primary_url ?? "");

        // SERVICES count is derived from JSON services list.
        const ready = jRow.services.filter(
          (s) => s.state === "ready" || s.state === "healthy",
        ).length;
        const failed = jRow.services.filter((s) => s.state === "failed").length;
        const expectedCount =
          failed > 0
            ? `${ready}/${jRow.services.length} (${failed} failed)`
            : `${ready}/${jRow.services.length}`;
        expect(tRow.services).toBe(expectedCount);
      }
    },
    180_000,
  );
});
