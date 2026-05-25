/**
 * Wire-format guard for failed-service rendering in the dashboard
 * (LEV-417, Plan 5 Task 15).
 *
 * The dashboard's failure UI (red badge + reason + log tail) is purely
 * visual — the load-bearing contract is the JSON shape `/api/stacks` and
 * `/api/stacks/:id` return. This file pins that shape down:
 *
 *   1. When a service is in the `failed` state, the `StackView` projection
 *      MUST surface `failure_reason` and `failure_log_tail` verbatim from
 *      the snapshot. The UI depends on these fields existing.
 *   2. When NO service in a stack is failed, the projection MUST leave both
 *      fields undefined (not emit empty strings, not emit empty arrays).
 *      Spurious empty arrays would lead the UI to render an empty "log
 *      tail" pane below each healthy service.
 *
 * These invariants double as a defensive guard against future changes to
 * `projectService` in `stacks-view.ts` — the failure metadata path is
 * narrow and easy to break accidentally.
 *
 * See also `tests/unit/daemon/dashboard/stacks-view.test.ts` for the
 * broader projection coverage; this file focuses solely on the failure
 * fields' wire-format invariants.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStackView,
  loadStacksView,
} from "../../../../src/daemon/dashboard/stacks-view.js";

// ---------------------------------------------------------------------------
// Fixture harness — fresh stateRoot per test (mirrors stacks-view.test.ts).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Failed services round-trip both failure fields into the StackView.
// ---------------------------------------------------------------------------

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

    const stacks = await loadStacksView(stateRoot);
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

    // The healthy peer must NOT carry these fields — the dashboard would
    // otherwise show stale failure context next to a successfully running
    // service. See guard test #2 for the broader version of this assertion.
    const web = stacks[0].services.find((s) => s.name === "web");
    expect(web).toBeDefined();
    expect(web!.failure_reason).toBeUndefined();
    expect(web!.failure_log_tail).toBeUndefined();
  });

  it("propagates failure fields through the single-stack loader too", async () => {
    // `/api/stacks/:id` calls loadStackView, not loadStacksView. Same
    // projection under the hood, but worth exercising both entry points
    // to guard against a future refactor that splits them.
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

    const stack = await loadStackView(stateRoot, "stack-1");
    expect(stack).not.toBeNull();
    expect(stack!.services).toHaveLength(1);
    expect(stack!.services[0].failure_reason).toBe("ready timeout");
    expect(stack!.services[0].failure_log_tail).toEqual([
      "bound to 5000",
      "waiting on health check",
    ]);
  });

  it("preserves an empty failure_log_tail array verbatim", async () => {
    // Edge case: failure detected before any log lines were captured (e.g.
    // a service that died inside `start_cmd` before its first stdout
    // write). The snapshot writer persists `failure_log_tail: []` in this
    // case; the wire format must preserve that distinction from "field
    // absent". The UI renders "(no log output captured)" for empty
    // arrays — collapsing them to `undefined` would lose that affordance.
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

    const stacks = await loadStacksView(stateRoot);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].services[0].failure_log_tail).toEqual([]);
    expect(stacks[0].services[0].failure_reason).toBe(
      "exited with code 127 (command not found)",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Stacks with no failed services: NEITHER field should appear per service.
// ---------------------------------------------------------------------------

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

    const stacks = await loadStacksView(stateRoot);
    expect(stacks).toHaveLength(1);

    for (const svc of stacks[0].services) {
      // Explicit per-service assertions so the failure message points at
      // exactly which service drifted into emitting spurious fields.
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
    // Defensive sanity check: a freshly-written snapshot from a new
    // installation has no failure fields anywhere in the services array.
    // The projection must not synthesize them.
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

    const stacks = await loadStacksView(stateRoot);
    expect(stacks).toHaveLength(1);
    const svc = stacks[0].services[0];

    // Both fields must be literally `undefined`, not `""` and not `[]`.
    expect(Object.hasOwn(svc, "failure_reason")).toBe(false);
    expect(Object.hasOwn(svc, "failure_log_tail")).toBe(false);
  });
});
