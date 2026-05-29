// undefined routing = "snapshot doesn't know about routing"; [] = "stack has no routes right now"
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import {
  type RoutingEntry,
  type StackSnapshot,
  readSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-test-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

function baseSnapshot(stackId: string, routing?: RoutingEntry[]): StackSnapshot {
  const snap: StackSnapshot = {
    stack_id: stackId,
    worktree_name: "feature-x",
    worktree_path: "/tmp/feature-x",
    status: "up",
    started_at: "2026-05-24T10:00:00.000Z",
    services: [
      {
        name: "api",
        kind: "owned",
        state: "ready",
        allocated_ports: { default: 9014 },
        started_at: "2026-05-24T10:00:01.000Z",
        pid: 12345,
      },
    ],
  };
  if (routing !== undefined) snap.routing = routing;
  return snap;
}

describe("StackSnapshot routing", () => {
  it("writeSnapshot + readSnapshot round-trips routing entries when present", async () => {
    const routing: RoutingEntry[] = [
      {
        hostname: "api.feature-x",
        upstream_url: "http://127.0.0.1:9014",
        service: "api",
      },
      {
        hostname: "web.feature-x",
        upstream_url: "http://127.0.0.1:9015",
        service: "web",
      },
    ];
    const snap = baseSnapshot("rt-set", routing);

    await writeSnapshot(snap);

    // Verify the raw on-disk JSON actually carries the routing block —
    // protects against sanitizeForWrite silently stripping it.
    const raw = readFileSync(join(stackDir("rt-set"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.routing).toEqual(routing);

    // And the readback path returns the same shape.
    const got = await readSnapshot("rt-set");
    expect(got).not.toBeNull();
    expect(got!.routing).toEqual(routing);
    // Full equality — verifies no other shape drift snuck in.
    expect(got).toEqual(snap);
  });

  it("readSnapshot returns routing === undefined when the field is absent (legacy snapshot)", async () => {
    // Simulate a state.json written by lich pre-Plan-5 — no `routing` key
    // anywhere in the document.
    const stackId = "rt-legacy";
    const dir = stackDir(stackId);
    await mkdir(dir, { recursive: true });
    const legacy = {
      stack_id: stackId,
      worktree_name: "main",
      worktree_path: "/tmp/legacy",
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
          started_at: "2026-05-23T10:00:01.000Z",
        },
      ],
    };
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(legacy, null, 2),
      "utf8",
    );

    const got = await readSnapshot(stackId);
    expect(got).not.toBeNull();
    expect(got!.routing).toBeUndefined();
    // Critical distinction: must not surface as `null` or `[]` — the field
    // is genuinely absent on legacy snapshots.
    expect(got!.routing).not.toBeNull();
    // Verify the rest of the snapshot parsed correctly so we know the
    // missing field didn't cascade into other problems.
    expect(got!.services).toHaveLength(1);
    expect(got!.services[0].name).toBe("postgres");
  });

  it("writeSnapshot + readSnapshot omits routing key entirely when undefined", async () => {
    // A snapshot written by lich with no routing set should not emit a
    // `"routing": null` key — undefined must not serialize as any artifact.
    const snap = baseSnapshot("rt-unset");
    expect(snap.routing).toBeUndefined();

    await writeSnapshot(snap);

    const raw = readFileSync(join(stackDir("rt-unset"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty("routing");

    const got = await readSnapshot("rt-unset");
    expect(got).not.toBeNull();
    expect(got!.routing).toBeUndefined();
  });

  it("writeSnapshot + readSnapshot round-trips routing: [] as an empty array (not undefined)", async () => {
    // The empty-array case is meaningful: `lich down` clears routing by
    // setting it to `[]` so the proxy stops serving the stack's routes
    // within one watcher tick. `[]` and `undefined` are NOT the same:
    //   - undefined: pre-Plan-5 snapshot, no routing was ever set.
    //   - []: routing was set, but the stack currently has zero routes.
    const snap = baseSnapshot("rt-empty", []);
    expect(snap.routing).toEqual([]);

    await writeSnapshot(snap);

    // Raw on-disk: the key MUST be present and MUST be an empty array.
    const raw = readFileSync(join(stackDir("rt-empty"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("routing");
    expect(parsed.routing).toEqual([]);

    // Readback: same empty array, not undefined, not null.
    const got = await readSnapshot("rt-empty");
    expect(got).not.toBeNull();
    expect(got!.routing).toEqual([]);
    expect(got!.routing).not.toBeUndefined();
    expect(got!.routing).not.toBeNull();
    expect(got).toEqual(snap);
  });

  it("preserves routing alongside a failed-service sanitize pass", async () => {
    // Make sure routing flows through the same `sanitizeForWrite` path that
    // strips failure_* from non-failed services. The two concerns are
    // independent and the routing block must survive untouched even when
    // services are being sanitized.
    const routing: RoutingEntry[] = [
      {
        hostname: "supabase-api.feature-x",
        upstream_url: "http://127.0.0.1:9011",
        service: "supabase",
      },
      {
        hostname: "supabase-db.feature-x",
        upstream_url: "http://127.0.0.1:9012",
        service: "supabase",
      },
    ];
    const snap: StackSnapshot = {
      stack_id: "rt-with-sanitize",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "partial",
      started_at: "2026-05-24T10:00:00.000Z",
      routing,
      services: [
        {
          // Non-failed service carrying stale failure_* — must be stripped.
          name: "api",
          kind: "owned",
          state: "ready",
          failure_reason: "stale from a prior attempt",
          failure_log_tail: ["should not be persisted"],
        },
        {
          // Failed service — failure_* must persist.
          name: "worker",
          kind: "owned",
          state: "failed",
          failure_reason: "exited with code 1",
          failure_log_tail: ["Error: boom"],
        },
      ],
    };

    await writeSnapshot(snap);

    const raw = readFileSync(
      join(stackDir("rt-with-sanitize"), "state.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);

    // Routing untouched by the sanitize pass.
    expect(parsed.routing).toEqual(routing);

    // Sanitize still did its job on services.
    expect(parsed.services[0]).not.toHaveProperty("failure_reason");
    expect(parsed.services[0]).not.toHaveProperty("failure_log_tail");
    expect(parsed.services[1].failure_reason).toBe("exited with code 1");
    expect(parsed.services[1].failure_log_tail).toEqual(["Error: boom"]);

    const got = await readSnapshot("rt-with-sanitize");
    expect(got).not.toBeNull();
    expect(got!.routing).toEqual(routing);
  });
});
