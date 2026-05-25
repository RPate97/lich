/**
 * Unit tests for the dashboard's `stacks-view` projection
 * (LEV-408, Plan 5 Task 6).
 *
 * `stacks-view.ts` is a pure read-only projection that turns the on-disk
 * per-stack `state.json` files into the dashboard-friendly `StackView`
 * shape served by the dashboard's REST endpoints. It mirrors
 * `commands/stacks.ts`'s `snapshotToRow` helper in spirit but exposes the
 * richer per-service detail the dashboard UI needs (failure reasons,
 * routing entries, allocated ports per service, etc.).
 *
 * Coverage:
 *   1. Empty `stateRoot` (no stacks at all)            → []
 *   2. Single stack → one StackView with the expected service rows
 *   3. Multiple stacks → one StackView per stack, sorted by worktree
 *   4. Snapshot without `routing` block                → primary_url undefined
 *   5. Snapshot with `routing` block                   → primary_url derived
 *   6. Malformed state.json                            → silently skipped + logged
 *   7. `loadStackView(root, "nonexistent")`            → null
 *   8. Missing `stateRoot` directory                   → [] (not an error)
 *   9. Failure metadata propagates through to the per-service view
 *  10. Active profile flows through verbatim
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStackView,
  loadStacksView,
} from "../../../../src/daemon/dashboard/stacks-view.js";

// ---------------------------------------------------------------------------
// Fixture harness — each test gets its own stateRoot tmpdir.
// ---------------------------------------------------------------------------

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-stacks-view-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

/**
 * Write a synthetic `state.json` for a given stack id. We bypass the
 * real `writeSnapshot` helper because that requires `LICH_HOME` plumbing
 * and we want full control over the exact shape on disk (including
 * deliberately-malformed cases later in the file).
 */
function writeStateJson(
  stackId: string,
  data: Record<string, unknown> | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

// ---------------------------------------------------------------------------
// 1. Empty / missing stateRoot
// ---------------------------------------------------------------------------

describe("loadStacksView — empty / missing stateRoot", () => {
  it("returns an empty array for an empty stateRoot", async () => {
    const result = await loadStacksView(stateRoot);
    expect(result).toEqual([]);
  });

  it("returns an empty array when stateRoot does not exist", async () => {
    // Fresh-install scenario: <LICH_HOME>/stacks doesn't exist yet. The
    // daemon may legitimately call us before any `lich up` has run.
    const missing = join(stateRoot, "does-not-exist");
    const result = await loadStacksView(missing);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Single stack → one StackView
// ---------------------------------------------------------------------------

describe("loadStacksView — single stack", () => {
  it("returns one StackView with the expected per-service detail", async () => {
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
      ],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);

    const stack = result[0];
    expect(stack.id).toBe("stack-1");
    expect(stack.worktree_name).toBe("feature-x");
    expect(stack.status).toBe("up");
    expect(stack.started_at).toBe("2026-05-24T10:00:00.000Z");
    expect(stack.services).toHaveLength(2);

    expect(stack.services[0]).toMatchObject({
      name: "api",
      kind: "owned",
      state: "ready",
      ports: { default: 9014 },
    });
    expect(stack.services[1]).toMatchObject({
      name: "web",
      kind: "compose",
      state: "healthy",
      ports: { default: 3000 },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple stacks → sorted by worktree name
// ---------------------------------------------------------------------------

describe("loadStacksView — multiple stacks", () => {
  it("returns one StackView per stack, sorted by worktree name", async () => {
    writeStateJson("z-stack", {
      stack_id: "z-stack",
      worktree_name: "z-feature",
      worktree_path: "/tmp/z",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });
    writeStateJson("a-stack", {
      stack_id: "a-stack",
      worktree_name: "a-feature",
      worktree_path: "/tmp/a",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });
    writeStateJson("m-stack", {
      stack_id: "m-stack",
      worktree_name: "m-feature",
      worktree_path: "/tmp/m",
      status: "partial",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(3);
    // Sorted alphabetically by worktree_name for deterministic display.
    expect(result.map((s) => s.worktree_name)).toEqual([
      "a-feature",
      "m-feature",
      "z-feature",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Snapshot without `routing` block → primary_url undefined
// ---------------------------------------------------------------------------

describe("loadStacksView — no routing block", () => {
  it("leaves primary_url undefined when the snapshot has no routing", async () => {
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
      ],
      // No `routing` field at all (pre-Plan-5 snapshot shape).
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].primary_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Snapshot with routing → primary_url derived from first routing entry
// ---------------------------------------------------------------------------

describe("loadStacksView — with routing block", () => {
  it("derives primary_url from the first routing entry", async () => {
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
      ],
      routing: [
        {
          hostname: "api.feature-x",
          upstream_url: "http://127.0.0.1:9014",
          service: "api",
        },
      ],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    // The dashboard wants a clickable friendly URL. The view layer
    // takes the first routing entry's upstream_url as a default — the
    // proxy port construction lives in the urls command path, not here.
    // The friendly form is computed by the consumer if needed; for
    // primary_url we just expose the upstream URL (matching the
    // `commands/stacks.ts` pattern of "first allocated port wins").
    expect(result[0].primary_url).toBe("http://127.0.0.1:9014");
  });

  it("leaves primary_url undefined when routing is empty array", async () => {
    // Empty routing array (just-torn-down stack via `lich down`'s
    // `routing: []` semantics) but services still listed in the
    // snapshot. Dashboard intentionally does NOT fall back to a raw
    // localhost URL here — an empty routing array means "no friendly
    // URL surface for this stack right now".
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
          allocated_ports: { default: 7777 },
        },
      ],
      routing: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].primary_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed state.json → silently skipped + logged
// ---------------------------------------------------------------------------

describe("loadStacksView — malformed state.json", () => {
  it("silently skips a stack with unparseable state.json (logs warning)", async () => {
    writeStateJson("broken", "this is not valid JSON {{{");
    writeStateJson("good", {
      stack_id: "good",
      worktree_name: "good-feature",
      worktree_path: "/tmp/good",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadStacksView(stateRoot);

    // The good stack still made it through; the broken one dropped out.
    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");

    // The broken one was logged so an operator can see the failure.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("silently skips entries that are files (not directories)", async () => {
    // Stray file at the state root — e.g. a `.DS_Store` or a
    // half-cleaned-up `daemon.pid` (which should live one level up but
    // could conceivably land here). `loadStacksView` must tolerate it.
    writeFileSync(join(stateRoot, "stray-file.txt"), "junk", "utf8");
    writeStateJson("good", {
      stack_id: "good",
      worktree_name: "good-feature",
      worktree_path: "/tmp/good",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");
  });

  it("silently skips stack directories without a state.json", async () => {
    // Orphan directory (crash recovery scenario, or stale `lich nuke`).
    mkdirSync(join(stateRoot, "orphan"), { recursive: true });
    writeStateJson("good", {
      stack_id: "good",
      worktree_name: "good-feature",
      worktree_path: "/tmp/good",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");
  });
});

// ---------------------------------------------------------------------------
// 7. loadStackView(root, id) — single-stack lookup
// ---------------------------------------------------------------------------

describe("loadStackView — single-stack lookup", () => {
  it("returns the requested stack when it exists", async () => {
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
      ],
    });

    const result = await loadStackView(stateRoot, "stack-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("stack-1");
    expect(result!.worktree_name).toBe("feature-x");
  });

  it("returns null for a nonexistent stack id", async () => {
    const result = await loadStackView(stateRoot, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when state.json is malformed (no throw)", async () => {
    writeStateJson("broken", "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadStackView(stateRoot, "broken");
    expect(result).toBeNull();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 9. Failure metadata propagates
// ---------------------------------------------------------------------------

describe("loadStacksView — failure metadata propagation", () => {
  it("preserves failure_reason and failure_log_tail on failed services", async () => {
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
          failure_reason: "port 9014 already in use",
          failure_log_tail: [
            "starting on 9014",
            "EADDRINUSE: address already in use",
            "exiting",
          ],
        },
      ],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].services[0].failure_reason).toBe(
      "port 9014 already in use",
    );
    expect(result[0].services[0].failure_log_tail).toEqual([
      "starting on 9014",
      "EADDRINUSE: address already in use",
      "exiting",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 10. Active profile flows through
// ---------------------------------------------------------------------------

describe("loadStacksView — active_profile passthrough", () => {
  it("surfaces active_profile when the snapshot has one", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      active_profile: "frontend",
      services: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].active_profile).toBe("frontend");
  });

  it("omits active_profile when the snapshot doesn't have one", async () => {
    writeStateJson("stack-1", {
      stack_id: "stack-1",
      worktree_name: "feature-x",
      worktree_path: "/tmp/feature-x",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot);
    expect(result).toHaveLength(1);
    expect(result[0].active_profile).toBeUndefined();
  });
});
