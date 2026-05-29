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

  // stub compose detection + exec so docker isn't touched
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

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): PassThrough {
  const stream = new PassThrough();
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

describe("runDown — clears routing entries on teardown", () => {
  it("clears a populated routing block to [] after teardown", async () => {
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
          // dead pid so SIGTERM is a silent no-op
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

    // routing is the empty array (not undefined) — explicit "no routes now"
    // vs. the absent-field "never set" semantics
    expect(snap?.routing).toEqual([]);
    expect(snap?.routing).not.toBeUndefined();
    expect(Array.isArray(snap?.routing)).toBe(true);
    expect(snap?.routing?.length).toBe(0);
  });

  it("writes routing: [] on a stack that never had routing entries (idempotent always-clear)", async () => {
    writeYaml(`
version: "1"
owned:
  svc:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "svc",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_641,
        },
      ],
    });

    const preSnap = await readSnapshot(stackId);
    expect(preSnap?.routing).toBeUndefined();

    const result = await runDown({
      cwd: projectDir,
      out: captureStdout(),
    });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.routing).toEqual([]);
    expect(snap?.routing).not.toBeUndefined();
  });

  it("does not crash when state.routing was undefined to start with", async () => {
    writeYaml(`
version: "1"
owned:
  ghost:
    cmd: "sleep 60"
`);

    const stackId = await seedSnapshot({
      services: [
        {
          name: "ghost",
          kind: "owned",
          state: "stopped",
          pid: 2_147_483_642,
        },
      ],
    });

    const preSnap = await readSnapshot(stackId);
    expect(preSnap?.routing).toBeUndefined();

    const result = await runDown({
      cwd: projectDir,
      out: captureStdout(),
    });

    expect(result.exitCode).toBe(0);
    const routingWarnings = result.warnings.filter((w) =>
      w.message.toLowerCase().includes("routing"),
    );
    expect(routingWarnings).toEqual([]);

    const snap = await readSnapshot(stackId);
    expect(snap?.status).toBe("stopped");
    expect(snap?.routing).toEqual([]);
  });
});
