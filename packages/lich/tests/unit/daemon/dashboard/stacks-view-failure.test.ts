import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStackView,
  loadStacksView,
} from "../../../../src/daemon/dashboard/stacks-view.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-stacks-view-failure-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function writeStateJson(
  stackId: string,
  data: Record<string, unknown>,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(data, null, 2), "utf8");
}

describe("stacks-view failure-field projection", () => {
  it("propagates failure_reason and failure_log_tail for a failed service", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "partial",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "failed",
          failure_reason: 'service "api" exited with code 1',
          failure_log_tail: [
            "starting api on port 4000",
            "Error: Cannot find module 'express'",
            "  at Module._resolveFilename (node:internal/modules/cjs/loader:1043:15)",
          ],
        },
        {
          name: "web",
          kind: "compose",
          state: "healthy",
          allocated_ports: { default: 3000 },
        },
      ],
    });

    const stacks = await loadStacksView(stateRoot, 3300);
    expect(stacks).toHaveLength(1);

    const api = stacks[0].services.find((s) => s.name === "api");
    expect(api).toBeDefined();
    expect(api!.state).toBe("failed");
    expect(api!.failure_reason).toBe('service "api" exited with code 1');
    expect(api!.failure_log_tail).toEqual([
      "starting api on port 4000",
      "Error: Cannot find module 'express'",
      "  at Module._resolveFilename (node:internal/modules/cjs/loader:1043:15)",
    ]);

    const web = stacks[0].services.find((s) => s.name === "web");
    expect(web).toBeDefined();
    expect(web!.failure_reason).toBeUndefined();
    expect(web!.failure_log_tail).toBeUndefined();
  });

  it("propagates failure fields through the single-stack loader too", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "failed",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "worker",
          kind: "owned",
          state: "failed",
          failure_reason: "ready timeout",
          failure_log_tail: ["bound to 5000", "waiting on health check"],
        },
      ],
    });

    const stack = await loadStackView(stateRoot, "stack-1", 3300);
    expect(stack).not.toBeNull();
    expect(stack!.services).toHaveLength(1);
    expect(stack!.services[0].failure_reason).toBe("ready timeout");
    expect(stack!.services[0].failure_log_tail).toEqual([
      "bound to 5000",
      "waiting on health check",
    ]);
  });

  it("preserves an empty failure_log_tail array verbatim", async () => {
    // empty array (failure before first log line) is distinct from "field absent" —
    // UI renders "(no log output captured)"
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "failed",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        {
          name: "worker",
          kind: "owned",
          state: "failed",
          failure_reason: "exited with code 127 (command not found)",
          failure_log_tail: [],
        },
      ],
    });

    const stacks = await loadStacksView(stateRoot, 3300);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].services[0].failure_log_tail).toEqual([]);
    expect(stacks[0].services[0].failure_reason).toBe(
      "exited with code 127 (command not found)",
    );
  });
});

describe("stacks-view — no spurious failure fields on healthy services", () => {
  it("leaves failure_reason / failure_log_tail undefined for every service in an all-healthy stack", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
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
        },
        {
          name: "web",
          kind: "compose",
          state: "healthy",
          allocated_ports: { default: 3000 },
        },
        {
          name: "postgres",
          kind: "compose",
          state: "healthy",
        },
      ],
    });

    const stacks = await loadStacksView(stateRoot, 3300);
    expect(stacks).toHaveLength(1);

    for (const svc of stacks[0].services) {
      expect(
        svc.failure_reason,
        `service "${svc.name}" should have no failure_reason`,
      ).toBeUndefined();
      expect(
        svc.failure_log_tail,
        `service "${svc.name}" should have no failure_log_tail`,
      ).toBeUndefined();
    }
  });

  it("does not invent empty arrays/strings even if the on-disk shape is bare", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "starting",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [
        { name: "api", kind: "owned", state: "starting" },
      ],
    });

    const stacks = await loadStacksView(stateRoot, 3300);
    expect(stacks).toHaveLength(1);
    const svc = stacks[0].services[0];

    expect(Object.hasOwn(svc, "failure_reason")).toBe(false);
    expect(Object.hasOwn(svc, "failure_log_tail")).toBe(false);
  });
});
