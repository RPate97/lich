/**
 * Tests for the per-service `failure_reason` / `failure_log_tail` fields on
 * `ServiceSnapshot` (LEV-359, Plan 4 Task 10).
 *
 * Plan 4 surfaces failures. State persistence is the first step: when the
 * orchestrator decides a service is `failed`, it stamps the reason + the
 * last few log lines onto the snapshot so the dashboard (Plan 5) and any
 * subsequent CLI invocation can render them without re-running the failed
 * service.
 *
 * Two invariants this file pins down:
 *
 *   1. The fields ROUND-TRIP: write a snapshot with them populated, read it
 *      back, the data is byte-for-byte equal.
 *   2. The fields are GATED on `state === "failed"`. If a caller carries
 *      stale failure metadata on a recovered service, it must NOT leak into
 *      state.json. Keeps the file clean for the dashboard.
 *
 * Back-compat: state.json files written before Plan 4 don't carry these
 * fields. Old snapshots must still parse via `readSnapshot`. We verify by
 * writing a raw JSON file by hand (the pre-Plan-4 shape) and reading it
 * back through the same code path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import {
  type ServiceSnapshot,
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

function baseSnapshot(stackId: string, services: ServiceSnapshot[]): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "main",
    worktree_path: "/tmp/some-worktree",
    status: "failed",
    started_at: "2026-05-24T10:00:00.000Z",
    services,
  };
}

describe("ServiceSnapshot failure fields", () => {
  it("writes failure_reason and failure_log_tail when service.state is 'failed'", async () => {
    const snap = baseSnapshot("s-write-failed", [
      {
        name: "api",
        kind: "owned",
        state: "failed",
        started_at: "2026-05-24T10:00:01.000Z",
        pid: 12345,
        failure_reason: 'service "api" exited with code 1',
        failure_log_tail: [
          "starting api on port 4000",
          "Error: Cannot find module 'express'",
          "  at Module._resolveFilename (node:internal/modules/cjs/loader:1043:15)",
        ],
      },
    ]);

    await writeSnapshot(snap);

    // Read raw bytes — verifies the fields actually landed on disk and
    // weren't silently dropped by sanitizeForWrite or JSON.stringify
    // shenanigans.
    const raw = readFileSync(join(stackDir("s-write-failed"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    const apiSvc = parsed.services[0];

    expect(apiSvc.state).toBe("failed");
    expect(apiSvc.failure_reason).toBe('service "api" exited with code 1');
    expect(apiSvc.failure_log_tail).toEqual([
      "starting api on port 4000",
      "Error: Cannot find module 'express'",
      "  at Module._resolveFilename (node:internal/modules/cjs/loader:1043:15)",
    ]);
  });

  it("reads back failure_reason and failure_log_tail from a snapshot", async () => {
    const snap = baseSnapshot("s-read-failed", [
      {
        name: "supabase",
        kind: "owned",
        state: "failed",
        failure_reason: "did not become ready within 90s",
        failure_log_tail: [
          "supabase: starting docker stack",
          "supabase: still waiting for postgres",
          "supabase: timeout",
        ],
      },
    ]);
    await writeSnapshot(snap);

    const got = await readSnapshot("s-read-failed");
    expect(got).not.toBeNull();
    const svc = got!.services[0];
    expect(svc.state).toBe("failed");
    expect(svc.failure_reason).toBe("did not become ready within 90s");
    expect(svc.failure_log_tail).toEqual([
      "supabase: starting docker stack",
      "supabase: still waiting for postgres",
      "supabase: timeout",
    ]);

    // Full round-trip equality — make sure no other fields changed shape.
    expect(got).toEqual(snap);
  });

  it("does not include failure fields when state is not 'failed'", async () => {
    // Caller hands us a snapshot with failure_* on a healthy service —
    // perhaps because they reused a snapshot object across a recovery.
    // The on-disk file must NOT carry the stale failure metadata.
    const snap = baseSnapshot("s-non-failed", [
      {
        name: "api",
        kind: "owned",
        state: "ready",
        started_at: "2026-05-24T10:00:01.000Z",
        pid: 12345,
        failure_reason: "stale leftover from a prior attempt",
        failure_log_tail: ["should not be persisted"],
      },
      {
        name: "worker",
        kind: "owned",
        state: "starting",
        failure_reason: "also stale",
        failure_log_tail: ["also should not be persisted"],
      },
    ]);

    await writeSnapshot(snap);

    const raw = readFileSync(join(stackDir("s-non-failed"), "state.json"), "utf8");
    const parsed = JSON.parse(raw);

    // The raw JSON must not contain the keys at all — not just `undefined`.
    expect(parsed.services[0]).not.toHaveProperty("failure_reason");
    expect(parsed.services[0]).not.toHaveProperty("failure_log_tail");
    expect(parsed.services[1]).not.toHaveProperty("failure_reason");
    expect(parsed.services[1]).not.toHaveProperty("failure_log_tail");

    // And round-tripping through readSnapshot also doesn't surface them.
    const got = await readSnapshot("s-non-failed");
    expect(got!.services[0].failure_reason).toBeUndefined();
    expect(got!.services[0].failure_log_tail).toBeUndefined();
    expect(got!.services[1].failure_reason).toBeUndefined();
    expect(got!.services[1].failure_log_tail).toBeUndefined();
  });

  it("parses an old snapshot without the failure fields", async () => {
    // Simulate a state.json written by lich pre-Plan-4 — same schema
    // version, no failure_reason / failure_log_tail anywhere.
    const stackId = "s-legacy";
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
        {
          // A pre-Plan-4 failed service has the `failed` state but no
          // failure metadata — code must tolerate that.
          name: "api",
          kind: "owned",
          state: "failed",
          started_at: "2026-05-23T10:00:02.000Z",
          pid: 12345,
        },
      ],
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2), "utf8");

    const got = await readSnapshot(stackId);
    expect(got).not.toBeNull();
    expect(got!.services).toHaveLength(2);

    const [postgres, api] = got!.services;
    expect(postgres.name).toBe("postgres");
    expect(postgres.state).toBe("ready");
    expect(postgres.failure_reason).toBeUndefined();
    expect(postgres.failure_log_tail).toBeUndefined();

    expect(api.name).toBe("api");
    expect(api.state).toBe("failed");
    // Legacy failed service: no failure metadata, but parse must succeed.
    expect(api.failure_reason).toBeUndefined();
    expect(api.failure_log_tail).toBeUndefined();
  });

  it("round-trips multiple failed services with distinct failure metadata", async () => {
    const snap = baseSnapshot("s-multi-failed", [
      {
        name: "api",
        kind: "owned",
        state: "failed",
        failure_reason: "EADDRINUSE on port 4000",
        failure_log_tail: ["Error: listen EADDRINUSE :::4000"],
      },
      {
        name: "worker",
        kind: "owned",
        state: "failed",
        failure_reason: "did not become ready within 30s",
        failure_log_tail: ["worker booting", "worker still booting"],
      },
      {
        name: "postgres",
        kind: "compose",
        state: "ready",
        allocated_ports: { POSTGRES_HOST_PORT: 54321 },
      },
    ]);

    await writeSnapshot(snap);
    const got = await readSnapshot("s-multi-failed");
    expect(got).toEqual(snap);
  });
});
