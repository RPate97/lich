import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStackView,
  loadStacksView,
} from "../../../../src/daemon/dashboard/stacks-view.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-stacks-view-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function writeStateJson(
  stackId: string,
  data: Record<string, unknown> | string,
): void {
  const dir = join(stateRoot, stackId);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, "state.json"), body, "utf8");
}

describe("loadStacksView — empty / missing stateRoot", () => {
  it("returns an empty array for an empty stateRoot", async () => {
    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toEqual([]);
  });

  it("returns an empty array when stateRoot does not exist", async () => {
    // fresh-install: daemon may call us before any `lich up` has run
    const missing = join(stateRoot, "does-not-exist");
    const result = await loadStacksView(missing, 3300);
    expect(result).toEqual([]);
  });
});

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

    const result = await loadStacksView(stateRoot, 3300);
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

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.worktree_name)).toEqual([
      "a-feature",
      "m-feature",
      "z-feature",
    ]);
  });
});

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
    });

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    expect(result[0].primary_url).toBeUndefined();
  });
});

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

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    // friendly form `http://<hostname>.lich.localhost:<proxy-port>/`
    expect(result[0].primary_url).toBe(
      "http://api.feature-x.lich.localhost:3300/",
    );
  });

  it("leaves primary_url undefined when routing is empty array", async () => {
    // empty routing = "no friendly URL surface" — do NOT fall back to a raw localhost URL
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

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    expect(result[0].primary_url).toBeUndefined();
  });
});

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

    const result = await loadStacksView(stateRoot, 3300);

    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("silently skips entries that are files (not directories)", async () => {
    writeFileSync(join(stateRoot, "stray-file.txt"), "junk", "utf8");
    writeStateJson("good", {
      stack_id: "good",
      worktree_name: "good-feature",
      worktree_path: "/tmp/good",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");
  });

  it("silently skips stack directories without a state.json", async () => {
    mkdirSync(join(stateRoot, "orphan"), { recursive: true });
    writeStateJson("good", {
      stack_id: "good",
      worktree_name: "good-feature",
      worktree_path: "/tmp/good",
      status: "up",
      started_at: "2026-05-24T10:00:00.000Z",
      services: [],
    });

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    expect(result[0].worktree_name).toBe("good-feature");
  });
});

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

    const result = await loadStackView(stateRoot, "stack-1", 3300);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("stack-1");
    expect(result!.worktree_name).toBe("feature-x");
  });

  it("returns null for a nonexistent stack id", async () => {
    const result = await loadStackView(stateRoot, "nonexistent", 3300);
    expect(result).toBeNull();
  });

  it("returns null when state.json is malformed (no throw)", async () => {
    writeStateJson("broken", "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadStackView(stateRoot, "broken", 3300);
    expect(result).toBeNull();
    warn.mockRestore();
  });
});

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

    const result = await loadStacksView(stateRoot, 3300);
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

    const result = await loadStacksView(stateRoot, 3300);
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

    const result = await loadStacksView(stateRoot, 3300);
    expect(result).toHaveLength(1);
    expect(result[0].active_profile).toBeUndefined();
  });
});
