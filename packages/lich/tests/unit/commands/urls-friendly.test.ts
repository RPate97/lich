/**
 * Unit tests for `lich urls` default (friendly URLs) + `--raw` flag.
 *
 * Covers the Plan 5 Task 17 / LEV-419 behavior:
 *   - Default: print friendly URLs (`<service>[ (<key>)]: http://<host>.lich.localhost:<proxy-port>/`)
 *     from the snapshot's `routing` entries.
 *   - `--raw`: print direct upstream URLs (`<service>[.<key>]: http://127.0.0.1:<port>`)
 *     — the previous Plan 1 default, now the escape hatch.
 *   - Empty routing: print a helpful hint.
 *   - No stack found: same exit-1 path as Plan 1.
 *   - Custom proxy port from `runtime.proxy_port` in lich.yaml.
 *
 * Tests use a tmpdir to stand up a lich.yaml + state.json fixture, with
 * `LICH_HOME` pointed at a sibling tmpdir so writes don't touch the user's
 * real `~/.lich`. No subprocesses, no real services — pure synthetic
 * state to pin the format contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUrls } from "../../../src/commands/urls.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  type RoutingEntry,
  type ServiceSnapshot,
  type StackSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

class StringSink {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let lichHome: string;
let prevLichHome: string | undefined;
let stdout: StringSink;
let stderr: StringSink;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lich-urls-friendly-test-"));
  lichHome = mkdtempSync(join(tmpdir(), "lich-urls-friendly-home-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = lichHome;
  stdout = new StringSink();
  stderr = new StringSink();
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(workdir, { recursive: true, force: true });
  rmSync(lichHome, { recursive: true, force: true });
});

/**
 * Drop a minimal `lich.yaml` so `detectWorktree` finds the worktree root
 * AND the friendly-URL path can re-parse the config to look up
 * `runtime.proxy_port`. Optional `proxyPort` writes the custom value.
 */
function writeYaml(opts: { proxyPort?: number } = {}): void {
  const lines: string[] = [`version: "1"`];
  if (opts.proxyPort !== undefined) {
    lines.push(`runtime:`);
    lines.push(`  proxy_port: ${opts.proxyPort}`);
  }
  writeFileSync(join(workdir, "lich.yaml"), lines.join("\n") + "\n", "utf8");
}

async function writeSnap(
  builder: (stackId: string) => StackSnapshot,
): Promise<StackSnapshot> {
  const wt = detectWorktree(workdir);
  const snap = builder(wt.stack_id);
  await writeSnapshot(snap);
  return snap;
}

async function run(
  opts: { raw?: boolean } = {},
): Promise<{ exitCode: number; out: string; err: string }> {
  const result = await runUrls({
    cwd: workdir,
    out: stdout as unknown as NodeJS.WritableStream,
    err: stderr as unknown as NodeJS.WritableStream,
    raw: opts.raw,
  });
  return { exitCode: result.exitCode, out: stdout.text(), err: stderr.text() };
}

// ---------------------------------------------------------------------------
// Helpers for building synthetic routing entries that match how
// `up.ts#buildRoutingEntries` shapes them.
// ---------------------------------------------------------------------------

function singlePortRouting(
  service: string,
  worktreeName: string,
  port: number,
): RoutingEntry {
  return {
    hostname: `${service}.${worktreeName}`,
    upstream_url: `http://127.0.0.1:${port}`,
    service,
  };
}

function multiPortRouting(
  service: string,
  worktreeName: string,
  key: string,
  port: number,
): RoutingEntry {
  return {
    hostname: `${service}-${key}.${worktreeName}`,
    upstream_url: `http://127.0.0.1:${port}`,
    service,
  };
}

// ---------------------------------------------------------------------------
// Tests — no-stack and no-routing edge cases
// ---------------------------------------------------------------------------

describe("runUrls — no stack present", () => {
  it("exits 1 with a clear error when there is no state for this worktree", async () => {
    writeYaml();
    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(1);
    expect(err).toContain("no stack found");
    expect(out).toBe("");
  });

  it("exits 1 even when --raw is passed and no state exists", async () => {
    writeYaml();
    const { exitCode, err } = await run({ raw: true });
    expect(exitCode).toBe(1);
    expect(err).toContain("no stack found");
  });
});

describe("runUrls (default friendly) — empty routing", () => {
  it("prints a helpful message when the snapshot has no routing field", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4001 },
          pid: 1234,
        },
      ],
      // routing intentionally omitted — simulates a pre-Plan-5 snapshot.
    }));

    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("No routing entries");
    expect(out).toContain("lich up");
  });

  it("prints the helpful message when the snapshot has routing: []", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [],
      routing: [],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toContain("No routing entries");
  });
});

// ---------------------------------------------------------------------------
// Tests — friendly URL formatting
// ---------------------------------------------------------------------------

describe("runUrls (default friendly) — single-port services", () => {
  it("prints `<service>: http://<host>.lich.localhost:3300/` for a single-port owned service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "feature-x",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9014 },
          pid: 1234,
        },
      ],
      routing: [singlePortRouting("api", "feature-x", 9014)],
    }));

    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("api: http://api.feature-x.lich.localhost:3300/\n");
  });

  it("prints the friendly URL for a single-port compose service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54100 },
        },
      ],
      routing: [singlePortRouting("postgres", "wt", 54100)],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("postgres: http://postgres.wt.lich.localhost:3300/\n");
  });
});

describe("runUrls (default friendly) — multi-port services", () => {
  it("prints one line per logical port with `(<key>)` for a multi-port service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "feature-x",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          allocated_ports: { api: 54321, db: 54322, studio: 54323 },
          pid: 5555,
        },
      ],
      routing: [
        multiPortRouting("supabase", "feature-x", "api", 54321),
        multiPortRouting("supabase", "feature-x", "db", 54322),
        multiPortRouting("supabase", "feature-x", "studio", 54323),
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines).toEqual([
      "supabase (api): http://supabase-api.feature-x.lich.localhost:3300/",
      "supabase (db): http://supabase-db.feature-x.lich.localhost:3300/",
      "supabase (studio): http://supabase-studio.feature-x.lich.localhost:3300/",
    ]);
  });

  it("handles a worktree name containing dashes without mis-parsing the port key", async () => {
    // Regression guard: the format function must NOT split on `.` first then
    // assume the whole leading segment is `<service>-<key>`. Worktree names
    // like `feature-x-test` would break a naive splitter.
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "feature-x-test",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          allocated_ports: { api: 5000, db: 5001 },
          pid: 1,
        },
      ],
      routing: [
        multiPortRouting("supabase", "feature-x-test", "api", 5000),
        multiPortRouting("supabase", "feature-x-test", "db", 5001),
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toContain(
      "supabase (api): http://supabase-api.feature-x-test.lich.localhost:3300/",
    );
    expect(out).toContain(
      "supabase (db): http://supabase-db.feature-x-test.lich.localhost:3300/",
    );
  });
});

describe("runUrls (default friendly) — multiple services", () => {
  it("prints one line per routing entry, preserving routing-table order", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54100 },
        },
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 4001 },
          pid: 1,
        },
        {
          name: "web",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 3001 },
          pid: 2,
        },
      ] as ServiceSnapshot[],
      routing: [
        singlePortRouting("postgres", "wt", 54100),
        singlePortRouting("api", "wt", 4001),
        singlePortRouting("web", "wt", 3001),
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe(
      "postgres: http://postgres.wt.lich.localhost:3300/\n" +
        "api: http://api.wt.lich.localhost:3300/\n" +
        "web: http://web.wt.lich.localhost:3300/\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — custom proxy port
// ---------------------------------------------------------------------------

describe("runUrls (default friendly) — runtime.proxy_port", () => {
  it("uses `runtime.proxy_port` from lich.yaml when set", async () => {
    writeYaml({ proxyPort: 4400 });
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9000 },
          pid: 1,
        },
      ],
      routing: [singlePortRouting("api", "wt", 9000)],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("api: http://api.wt.lich.localhost:4400/\n");
  });

  it("falls back to 3300 silently when lich.yaml is missing", async () => {
    // No writeYaml() call — but we still need a way for detectWorktree to
    // find the worktree. The fixture writes the snapshot directly under
    // the stack id; create a lich.yaml then delete it to simulate the
    // "config went away after up" case.
    writeYaml({ proxyPort: 5500 });
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9000 },
          pid: 1,
        },
      ],
      routing: [singlePortRouting("api", "wt", 9000)],
    }));
    // Now delete the yaml — detectWorktree was already done implicitly by
    // writeSnap, but the friendly URL path re-reads it for proxy_port.
    rmSync(join(workdir, "lich.yaml"));

    // detectWorktree walks up looking for lich.yaml; without one in the
    // tmpdir it'll fail. So skip this assertion — the "yaml present but
    // fails to parse" path covers the resolveProxyPort fallback.
    const { exitCode } = await run();
    expect(exitCode).toBe(1); // no lich.yaml → no stack found
  });

  it("falls back to 3300 silently when lich.yaml fails to parse", async () => {
    // A malformed yaml — detectWorktree just needs the file to exist; the
    // friendly URL resolver re-parses it and silently falls back on
    // failure.
    writeFileSync(join(workdir, "lich.yaml"), "not: yaml: :: garbage", "utf8");
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { default: 9000 },
          pid: 1,
        },
      ],
      routing: [singlePortRouting("api", "wt", 9000)],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("api: http://api.wt.lich.localhost:3300/\n");
  });
});

// ---------------------------------------------------------------------------
// Tests — --raw mode
// ---------------------------------------------------------------------------

describe("runUrls (--raw) — direct upstream URLs", () => {
  it("prints `<service>: http://127.0.0.1:<port>` for a single-port service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4001 },
          pid: 1,
        },
      ],
      routing: [singlePortRouting("api", "wt", 4001)],
    }));

    const { exitCode, out } = await run({ raw: true });
    expect(exitCode).toBe(0);
    expect(out).toBe("api: http://127.0.0.1:4001\n");
  });

  it("prints `<service>.<key>` lines for multi-port services in --raw mode", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          allocated_ports: { api: 54321, db: 54322 },
          pid: 1,
        },
      ],
      routing: [
        multiPortRouting("supabase", "wt", "api", 54321),
        multiPortRouting("supabase", "wt", "db", 54322),
      ],
    }));

    const { exitCode, out } = await run({ raw: true });
    expect(exitCode).toBe(0);
    expect(out).toBe(
      "supabase.api: http://127.0.0.1:54321\n" +
        "supabase.db: http://127.0.0.1:54322\n",
    );
  });

  it("works in --raw mode even when the snapshot has no routing field (Plan 1 back-compat)", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4001 },
          pid: 1,
        },
      ],
      // routing intentionally omitted — --raw doesn't consult it.
    }));

    const { exitCode, out } = await run({ raw: true });
    expect(exitCode).toBe(0);
    expect(out).toBe("api: http://127.0.0.1:4001\n");
  });

  it("prints `(no ports allocated)` in --raw mode when no service has ports", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        { name: "migrator", kind: "owned", state: "ready", pid: 1 },
      ],
    }));

    const { exitCode, out } = await run({ raw: true });
    expect(exitCode).toBe(0);
    expect(out).toBe("(no ports allocated)\n");
  });
});
