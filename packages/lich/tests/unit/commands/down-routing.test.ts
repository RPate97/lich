/**
 * Unit tests for `runDown` clearing the stack's routing entries (LEV-412,
 * Plan 5 Task 10).
 *
 * Contract: after `runDown` completes successfully on a stack, the on-disk
 * `state.json` MUST carry `routing: []` (an empty array, NOT undefined). The
 * two are semantically distinct (see the JSDoc on `StackSnapshot.routing`):
 *
 *   - `undefined`: this snapshot never declared routes (pre-Plan-5, or
 *     mid-startup before `up` populated them).
 *   - `[]`: routing was actively cleared — "this stack has zero routes right
 *     now," which is precisely what `down` signals.
 *
 * The Plan 5 daemon's reverse proxy watches `state.json` and removes routes
 * for stacks that go to the empty-or-missing state. Writing `[]` rather than
 * leaving the previous routing intact ensures the proxy stops serving stale
 * upstream URLs within one watcher tick (~100ms).
 *
 * Idempotent by design: down ALWAYS clears routing on the final snapshot
 * write, regardless of the pre-down value (set, empty, or undefined). The
 * three tests below pin all three pre-states.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runDown } from "../../../src/commands/down.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  readSnapshot,
  writeSnapshot,
  type RoutingEntry,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { release } from "../../../src/ports/allocator.js";
import { _exec, type ExecFn } from "../../../src/compose/runner.js";
import { _probe } from "../../../src/compose/detect.js";

// ---------------------------------------------------------------------------
// Per-test isolation — mirrors down.test.ts conventions.
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];
let originalExec: ExecFn;
let originalProbe: typeof _probe.current;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-down-routing-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-down-routing-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];

  // Stub compose detection + exec so docker isn't touched.
  originalProbe = _probe.current;
  _probe.current = async (cmd) => cmd === "docker";
  originalExec = _exec.current;
  _exec.current = async () => ({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  _exec.current = originalExec;
  _probe.current = originalProbe;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): PassThrough {
  const stream = new PassThrough();
  // Drain — tests assert on the snapshot, not stdout.
  stream.on("data", () => {});
  return stream;
}

async function seedSnapshot(
  overrides: Partial<StackSnapshot> & { services: ServiceSnapshot[] },
): Promise<string> {
  const wt = detectWorktree(projectDir);
  const snap: StackSnapshot = {
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    ...overrides,
  };
  await writeSnapshot(snap);
  createdStackIds.push(wt.stack_id);
  return wt.stack_id;
}

// ---------------------------------------------------------------------------
// LEV-412: routing is cleared on teardown
// ---------------------------------------------------------------------------

describe("runDown — clears routing entries on teardown (LEV-412)", () => {
  it("clears a populated routing block to [] after teardown", async () => {
    // Common case: stack was up, had routes registered, now tearing down.
    // The proxy needs to see `routing: []` (within one watcher tick) so it
    // stops forwarding to the upstreams that are about to disappear.
    writeYaml(`
version: "1"
owned:
  api:
    cmd: "sleep 60"
`);

    const routing: RoutingEntry[] = [
      {
        hostname: "api.feature-x",
        upstream_url: "http://127.0.0.1:9014",
        service: "api",
      },
      {
        hostname: "supabase-api.feature-x",
        upstream_url: "http://127.0.0.1:9015",
        service: "supabase",
      },
    ];

    const stackId = await seedSnapshot({
      routing,
      services: [
        {
          name: "api",
          kind: "owned",
          state: "stopped",
          // Dead pid so SIGTERM is a silent no-op — the only state change
          // observable post-down is the bookkeeping (status + routing).
          pid: 2_147_483_640,
        },
      ],
    });

    const result = await runDown({
      cwd: projectDir,
      out: captureStdout(),
    });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    expect(snap).not.toBeNull();
    expect(snap?.status).toBe("stopped");

    // The contract: routing is the empty array. NOT undefined — the empty
    // array is the explicit signal that this stack actively has no routes
    // right now, vs. the older absent-field semantics ("never set").
    expect(snap?.routing).toEqual([]);
    expect(snap?.routing).not.toBeUndefined();
    // Belt-and-braces: it's an array of length 0, not some falsy non-array.
    expect(Array.isArray(snap?.routing)).toBe(true);
    expect(snap?.routing?.length).toBe(0);
  });

  it("writes routing: [] on a stack that never had routing entries (idempotent always-clear)", async () => {
    // Pre-Plan-5 stack (or any stack that came up without routes — no
    // allocated ports, mid-startup failure, etc.). Down's always-clear
    // behavior means we write `routing: []` regardless of the prior value;
    // this keeps the snapshot's "did down run?" signal unambiguous and
    // means the proxy doesn't have to special-case "absent" vs. "empty."
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      // No `routing` field at all — mirrors a snapshot written by older
      // lich or by an up that crashed before routing was populated.
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_641,
        },
      ],
    });

    // Sanity: the seed snapshot really doesn't carry routing.
    const preSnap = await readSnapshot(stackId);
    expect(preSnap?.routing).toBeUndefined();

    const result = await runDown({
      cwd: projectDir,
      out: captureStdout(),
    });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    // Post-down: routing is the empty array, NOT undefined — always-clear.
    expect(snap?.routing).toEqual([]);
    expect(snap?.routing).not.toBeUndefined();
  });

  it("does not crash when state.routing was undefined to start with", async () => {
    // The robustness pin: even with a fully bare snapshot (no routing key
    // on disk, no allocated_ports, nothing for the proxy to have been
    // routing), down must complete cleanly. Reflects the most pessimistic
    // input shape — a snapshot from very-early up or one that's been edited
    // by hand. This test guards against a regression where down assumes a
    // particular pre-state of `state.routing` (e.g. tries to read from it,
    // or chains methods on it without a guard).
    writeYaml(`
version: "1"
owned:
  ghost:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      // Explicitly omit routing — the seed helper only sets the fields the
      // overrides specify, and we don't specify routing, so the on-disk
      // snapshot has no routing field at all.
      services: [
        {
          name: "ghost",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_642,
        },
      ],
    });

    // Confirm there's no routing field on disk.
    const preSnap = await readSnapshot(stackId);
    expect(preSnap?.routing).toBeUndefined();

    // The act: runDown must NOT throw, even with state.routing === undefined.
    const result = await runDown({
      cwd: projectDir,
      out: captureStdout(),
    });

    // No crash, exit 0, no warnings related to routing clearing.
    expect(result.exitCode).toBe(0);
    const routingWarnings = result.warnings.filter((w) =>
      w.message.toLowerCase().includes("routing"),
    );
    expect(routingWarnings).toEqual([]);

    // And the always-clear contract still holds — routing is now [].
    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.routing).toEqual([]);
  });
});
