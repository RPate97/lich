import { describe, expect, it } from "vitest";

import {
  type StackRow,
  renderJson,
  renderPretty,
  snapshotToRow,
} from "../../../src/commands/stacks.js";
import type { StackSnapshot } from "../../../src/state/snapshot.js";

const NOW = Date.parse("2026-05-30T12:00:00Z");

function isoMinusSeconds(s: number): string {
  return new Date(NOW - s * 1000).toISOString();
}

function snap(overrides: Partial<StackSnapshot> & { stack_id: string }): StackSnapshot {
  return {
    worktree_name: overrides.stack_id,
    worktree_path: `/tmp/${overrides.stack_id}`,
    status: "up",
    started_at: isoMinusSeconds(60),
    services: [],
    ...overrides,
  };
}

interface ParsedJsonRow {
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

function parseJson(text: string): ParsedJsonRow[] {
  return JSON.parse(text) as ParsedJsonRow[];
}

interface ParsedTableRow {
  worktree: string;
  status: string;
  uptime: string;
  services: string;
  url: string;
}

function parseTable(text: string): { headers: string[]; rows: ParsedTableRow[] } {
  const lines = text.trimEnd().split("\n");
  const headers = lines[0].split(/\s{2,}/).map((s) => s.trim());
  const rows: ParsedTableRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(/\s{2,}/).map((s) => s.trim());
    rows.push({
      worktree: cells[0] ?? "",
      status: cells[1] ?? "",
      uptime: cells[2] ?? "",
      services: cells[3] ?? "",
      url: cells[4] ?? "",
    });
  }
  return { headers, rows };
}

function rowsFromSnapshots(snapshots: StackSnapshot[]): StackRow[] {
  return snapshots
    .map((s) => snapshotToRow(s, NOW))
    .sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));
}

describe("stacks renderer parity — single source of truth (LEV-532)", () => {
  it("clean up: every table field is derivable from the JSON for a healthy stack", () => {
    const snapshots = [
      snap({
        stack_id: "s1",
        worktree_name: "alpha",
        status: "up",
        started_at: isoMinusSeconds(3600),
        active_profile: "dev:fast",
        services: [
          {
            name: "api",
            kind: "owned",
            state: "ready",
            allocated_ports: { PORT: 9001 },
          },
          { name: "web", kind: "owned", state: "ready" },
        ],
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const tableText = renderPretty(rows);
    const jsonText = renderJson(rows);
    const table = parseTable(tableText);
    const json = parseJson(jsonText);

    expect(table.rows).toHaveLength(1);
    expect(json).toHaveLength(1);

    const [tRow] = table.rows;
    const [jRow] = json;

    expect(tRow.worktree).toBe(jRow.worktree_name);
    expect(tRow.status).toBe(jRow.status);
    expect(tRow.url).toBe(jRow.primary_url ?? "");
    // SERVICES cell encodes ready_count/total_count derived from JSON services
    const ready = jRow.services.filter((s) => s.state === "ready" || s.state === "healthy").length;
    expect(tRow.services).toBe(`${ready}/${jRow.services.length}`);
    // active_profile is wire-only — table doesn't show it, but it's recoverable from JSON
    expect(jRow.active_profile).toBe("dev:fast");
  });

  it("failed after_up hook: table suffix is derivable from JSON.lifecycle", () => {
    const snapshots = [
      snap({
        stack_id: "s2",
        worktree_name: "bravo",
        status: "failed",
        services: [
          { name: "api", kind: "owned", state: "ready" },
          { name: "web", kind: "owned", state: "ready" },
          { name: "worker", kind: "owned", state: "ready" },
        ],
        lifecycle: {
          before_up: { status: "ok" },
          after_up: {
            status: "failed",
            failed_index: 1,
            total: 3,
            failed_cmd: "pnpm db:reset",
            log_path: "/home/.lich/stacks/s2/logs/after_up.log",
          },
        },
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const table = parseTable(renderPretty(rows));
    const [json] = parseJson(renderJson(rows));

    const [tRow] = table.rows;
    expect(tRow.worktree).toBe(json.worktree_name);
    // Status base matches JSON; suffix encodes lifecycle data
    expect(tRow.status.startsWith(json.status)).toBe(true);
    const lifecycle = json.lifecycle as Record<string, { status: string; failed_index?: number; total?: number; failed_cmd?: string }>;
    const afterUp = lifecycle.after_up;
    expect(afterUp.status).toBe("failed");
    // Suffix is fully reconstructable: phase, i+1/n, cmd
    const expectedSuffix = `(after_up ${(afterUp.failed_index ?? 0) + 1}/${afterUp.total}: ${afterUp.failed_cmd})`;
    expect(tRow.status).toBe(`${json.status} ${expectedSuffix}`);
    // services counts still derivable
    const ready = json.services.filter((s) => s.state === "ready" || s.state === "healthy").length;
    expect(tRow.services).toBe(`${ready}/${json.services.length}`);
  });

  it("mixed-state services: failed count in table matches JSON service states", () => {
    const snapshots = [
      snap({
        stack_id: "s3",
        worktree_name: "charlie",
        status: "partial",
        services: [
          { name: "api", kind: "owned", state: "ready" },
          { name: "web", kind: "owned", state: "healthy" },
          { name: "worker", kind: "owned", state: "failed" },
          { name: "scheduler", kind: "owned", state: "starting" },
        ],
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const table = parseTable(renderPretty(rows));
    const [json] = parseJson(renderJson(rows));
    const [tRow] = table.rows;

    expect(tRow.status).toBe(json.status);
    const ready = json.services.filter((s) => s.state === "ready" || s.state === "healthy").length;
    const failed = json.services.filter((s) => s.state === "failed").length;
    expect(tRow.services).toBe(`${ready}/${json.services.length} (${failed} failed)`);
  });

  it("multiple stacks: row count and order match between renderers", () => {
    const snapshots = [
      snap({ stack_id: "id-zulu", worktree_name: "zulu", services: [{ name: "x", kind: "owned", state: "ready" }] }),
      snap({ stack_id: "id-alpha", worktree_name: "alpha", services: [{ name: "x", kind: "owned", state: "ready" }] }),
      snap({ stack_id: "id-mike", worktree_name: "mike", services: [{ name: "x", kind: "owned", state: "ready" }] }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const table = parseTable(renderPretty(rows));
    const json = parseJson(renderJson(rows));

    expect(table.rows.length).toBe(json.length);
    expect(table.rows.map((r) => r.worktree)).toEqual(json.map((j) => j.worktree_name));
  });

  it("uptime: table HH:MM:SS encoding is derivable from JSON.uptime_seconds", () => {
    const snapshots = [
      snap({
        stack_id: "s4",
        worktree_name: "delta",
        started_at: isoMinusSeconds(3661),
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const table = parseTable(renderPretty(rows));
    const [json] = parseJson(renderJson(rows));

    expect(json.uptime_seconds).toBe(3661);
    expect(table.rows[0].uptime).toBe("01:01:01");
  });

  it("empty list: both renderers produce empty-but-coherent output", () => {
    const rows: StackRow[] = [];
    expect(renderPretty(rows)).toBe("no stacks running");
    expect(JSON.parse(renderJson(rows))).toEqual([]);
  });

  it("legacy snapshot (no lifecycle): JSON omits lifecycle and table omits status suffix", () => {
    const snapshots = [
      snap({
        stack_id: "leg",
        worktree_name: "legacy",
        status: "failed",
        services: [{ name: "a", kind: "owned", state: "failed" }],
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    const [json] = parseJson(renderJson(rows));
    expect("lifecycle" in json).toBe(false);

    const table = parseTable(renderPretty(rows));
    expect(table.rows[0].status).toBe("failed");
    expect(table.rows[0].status).not.toContain("(");
  });

  it("both renderers consume the SAME StackRow[] (locks single source of truth)", () => {
    const snapshots = [
      snap({
        stack_id: "src",
        worktree_name: "src",
        started_at: isoMinusSeconds(10),
        services: [
          { name: "api", kind: "owned", state: "ready", allocated_ports: { PORT: 4242 } },
        ],
      }),
    ];
    const rows = rowsFromSnapshots(snapshots);

    // Calling each renderer twice with the SAME input must produce identical output.
    expect(renderPretty(rows)).toBe(renderPretty(rows));
    expect(renderJson(rows)).toBe(renderJson(rows));

    // Mutating a row would affect both outputs identically (no hidden copies).
    const mutated = structuredClone(rows);
    mutated[0].worktree_name = "mutated";
    expect(renderPretty(mutated)).toContain("mutated");
    expect(renderJson(mutated)).toContain('"worktree_name": "mutated"');
  });
});
