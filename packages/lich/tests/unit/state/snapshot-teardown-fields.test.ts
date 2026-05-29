import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackDir } from "../../../src/state/directory.js";
import {
  type SnapshotLifecycleEntry,
  type StackSnapshot,
  readSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-test-teardown-"));
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

function baseSnap(stackId: string): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "main",
    worktree_path: "/tmp/main",
    status: "up",
    started_at: "2026-05-28T10:00:00.000Z",
    services: [],
  };
}

describe("ServiceSnapshot teardown fields", () => {
  it("round-trips stop_cmd, cmd, resolved_env, depends_on, and before_down", async () => {
    const beforeDown: SnapshotLifecycleEntry[] = [
      { cmd: "echo stopping", env: { MY_VAR: "resolved-value" } },
    ];
    const snap: StackSnapshot = {
      ...baseSnap("svc-teardown-fields"),
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          stop_cmd: "bun run stop",
          resolved_env: { PORT: "9001", NODE_ENV: "development" },
          depends_on: ["postgres"],
          before_down: beforeDown,
          allocated_ports: { default: 9001 },
          pid: 12345,
        },
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          depends_on: [],
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
        },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-teardown-fields"), "state.json"), "utf8"),
    );

    const api = raw.services[0];
    expect(api.cmd).toBe("bun run dev");
    expect(api.stop_cmd).toBe("bun run stop");
    expect(api.resolved_env).toEqual({ PORT: "9001", NODE_ENV: "development" });
    expect(api.depends_on).toEqual(["postgres"]);
    expect(api.before_down).toEqual(beforeDown);

    const pg = raw.services[1];
    expect(pg.depends_on).toEqual([]);

    const got = await readSnapshot("svc-teardown-fields");
    expect(got).not.toBeNull();
    expect(got).toEqual(snap);
  });

  it("omits optional teardown fields when not set", async () => {
    const snap: StackSnapshot = {
      ...baseSnap("svc-teardown-absent"),
      services: [
        { name: "web", kind: "owned", state: "ready" },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-teardown-absent"), "state.json"), "utf8"),
    );
    const svc = raw.services[0];
    expect(svc).not.toHaveProperty("stop_cmd");
    expect(svc).not.toHaveProperty("cmd");
    expect(svc).not.toHaveProperty("resolved_env");
    expect(svc).not.toHaveProperty("depends_on");
    expect(svc).not.toHaveProperty("before_down");

    const got = await readSnapshot("svc-teardown-absent");
    expect(got).not.toBeNull();
    const svcGot = got!.services[0];
    expect(svcGot.stop_cmd).toBeUndefined();
    expect(svcGot.cmd).toBeUndefined();
    expect(svcGot.resolved_env).toBeUndefined();
    expect(svcGot.depends_on).toBeUndefined();
    expect(svcGot.before_down).toBeUndefined();
  });
});

describe("StackSnapshot teardown fields (before_down / after_down)", () => {
  it("round-trips before_down and after_down entries with resolved envs", async () => {
    const beforeDown: SnapshotLifecycleEntry[] = [
      { cmd: "supabase stop", env: { SUPABASE_PROJECT_ID: "proj-abc", HOME: "/root" } },
      { cmd: "echo done", env: { PATH: "/usr/bin" } },
    ];
    const afterDown: SnapshotLifecycleEntry[] = [
      { cmd: "rm -rf /tmp/scratch", env: { TMPDIR: "/tmp" } },
    ];

    const snap: StackSnapshot = {
      ...baseSnap("stack-teardown-hooks"),
      before_down: beforeDown,
      after_down: afterDown,
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("stack-teardown-hooks"), "state.json"), "utf8"),
    );
    expect(raw.before_down).toEqual(beforeDown);
    expect(raw.after_down).toEqual(afterDown);

    const got = await readSnapshot("stack-teardown-hooks");
    expect(got).not.toBeNull();
    expect(got!.before_down).toEqual(beforeDown);
    expect(got!.after_down).toEqual(afterDown);
    expect(got).toEqual(snap);
  });

  it("omits before_down and after_down when not set", async () => {
    const snap = baseSnap("stack-teardown-absent");

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("stack-teardown-absent"), "state.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("before_down");
    expect(raw).not.toHaveProperty("after_down");

    const got = await readSnapshot("stack-teardown-absent");
    expect(got).not.toBeNull();
    expect(got!.before_down).toBeUndefined();
    expect(got!.after_down).toBeUndefined();
  });

  it("tolerates legacy snapshot without teardown fields", async () => {
    const stackId = "stack-legacy-no-teardown";
    const { mkdir } = await import("node:fs/promises");
    const { writeFileSync } = await import("node:fs");
    const dir = stackDir(stackId);
    await mkdir(dir, { recursive: true });
    const legacy = {
      stack_id: stackId,
      worktree_name: "main",
      worktree_path: "/tmp/main",
      status: "up",
      started_at: "2026-05-28T10:00:00.000Z",
      services: [{ name: "api", kind: "owned", state: "ready" }],
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2), "utf8");

    const got = await readSnapshot(stackId);
    expect(got).not.toBeNull();
    expect(got!.before_down).toBeUndefined();
    expect(got!.after_down).toBeUndefined();
    expect(got!.services[0].stop_cmd).toBeUndefined();
    expect(got!.services[0].resolved_env).toBeUndefined();
    expect(got!.services[0].depends_on).toBeUndefined();
  });
});
