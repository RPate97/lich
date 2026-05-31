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

  it("round-trips owned_containers.label on a service snapshot", async () => {
    const snap: StackSnapshot = {
      ...baseSnap("svc-owned-containers-label"),
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          stop_cmd: "supabase stop",
          owned_containers: { label: "com.supabase.cli.project=demo-abc123" },
        },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-owned-containers-label"), "state.json"), "utf8"),
    );
    expect(raw.services[0].owned_containers).toEqual({
      label: "com.supabase.cli.project=demo-abc123",
    });

    const got = await readSnapshot("svc-owned-containers-label");
    expect(got).not.toBeNull();
    expect(got!.services[0].owned_containers).toEqual({
      label: "com.supabase.cli.project=demo-abc123",
    });
  });

  it("round-trips owned_containers.name_pattern on a service snapshot", async () => {
    const snap: StackSnapshot = {
      ...baseSnap("svc-owned-containers-name"),
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          stop_cmd: "supabase stop",
          owned_containers: { name_pattern: "supabase_*_demo-abc123" },
        },
      ],
    };

    await writeSnapshot(snap);

    const got = await readSnapshot("svc-owned-containers-name");
    expect(got).not.toBeNull();
    expect(got!.services[0].owned_containers).toEqual({
      name_pattern: "supabase_*_demo-abc123",
    });
  });

  it("omits owned_containers when not set", async () => {
    const snap: StackSnapshot = {
      ...baseSnap("svc-owned-containers-absent"),
      services: [
        { name: "api", kind: "owned", state: "ready", stop_cmd: "echo stop" },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-owned-containers-absent"), "state.json"), "utf8"),
    );
    expect(raw.services[0]).not.toHaveProperty("owned_containers");
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
    expect(svc).not.toHaveProperty("before_start");
    expect(svc).not.toHaveProperty("after_ready");
    expect(svc).not.toHaveProperty("fail_when");

    const got = await readSnapshot("svc-teardown-absent");
    expect(got).not.toBeNull();
    const svcGot = got!.services[0];
    expect(svcGot.stop_cmd).toBeUndefined();
    expect(svcGot.cmd).toBeUndefined();
    expect(svcGot.resolved_env).toBeUndefined();
    expect(svcGot.depends_on).toBeUndefined();
    expect(svcGot.before_down).toBeUndefined();
    expect(svcGot.before_start).toBeUndefined();
    expect(svcGot.after_ready).toBeUndefined();
    expect(svcGot.fail_when).toBeUndefined();
  });

  it("round-trips before_start and after_ready per-service hooks with resolved envs (LEV-540 / LEV-541)", async () => {
    const beforeStart: SnapshotLifecycleEntry[] = [
      { cmd: "mkdir -p /tmp/lich-work", env: { HOME: "/root" } },
    ];
    const afterReady: SnapshotLifecycleEntry[] = [
      { cmd: 'curl -fsS "http://localhost:9001/health"', env: { API_URL: "http://localhost:9001" } },
    ];
    const snap: StackSnapshot = {
      ...baseSnap("svc-per-service-hooks"),
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          resolved_env: { PORT: "9001" },
          before_start: beforeStart,
          after_ready: afterReady,
        },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-per-service-hooks"), "state.json"), "utf8"),
    );
    const api = raw.services[0];
    expect(api.before_start).toEqual(beforeStart);
    expect(api.after_ready).toEqual(afterReady);

    const got = await readSnapshot("svc-per-service-hooks");
    expect(got).not.toBeNull();
    expect(got!.services[0].before_start).toEqual(beforeStart);
    expect(got!.services[0].after_ready).toEqual(afterReady);
  });

  it("round-trips fail_when config on a service snapshot (LEV-542)", async () => {
    const snap: StackSnapshot = {
      ...baseSnap("svc-fail-when"),
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          resolved_env: { PORT: "9001" },
          fail_when: { log_match: "EADDRINUSE" },
        },
      ],
    };

    await writeSnapshot(snap);

    const raw = JSON.parse(
      readFileSync(join(stackDir("svc-fail-when"), "state.json"), "utf8"),
    );
    expect(raw.services[0].fail_when).toEqual({ log_match: "EADDRINUSE" });

    const got = await readSnapshot("svc-fail-when");
    expect(got).not.toBeNull();
    expect(got!.services[0].fail_when).toEqual({ log_match: "EADDRINUSE" });
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
