import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture REAL modules BEFORE installing the mocks. Bun's `mock.module`
// (which `vi.mock` desugars to) is GLOBAL — without restoration in afterAll,
// later test files in the same `bun test` run see the mocked module too.
const realDownModule = await import("../../../src/commands/down.js");
const realUpModule = await import("../../../src/commands/up.js");

const runDownSpy = vi.fn(
  async () => ({ exitCode: 0, warnings: [] }) as { exitCode: number; warnings: unknown[] },
);
const runUpSpy = vi.fn(
  async () => ({ exitCode: 0 }) as {
    exitCode: number;
    stackId?: string;
    services?: Array<{ name: string; state: string }>;
  },
);
vi.mock("../../../src/commands/down.js", () => ({
  runDown: (...args: unknown[]) => runDownSpy(...args),
}));
vi.mock("../../../src/commands/up.js", () => ({
  runUp: (...args: unknown[]) => runUpSpy(...args),
}));

import { runRestart } from "../../../src/commands/restart.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  writeSnapshot,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";

let lichHome: string;
let prevLichHome: string | undefined;
let stackPath: string;

beforeEach(() => {
  runDownSpy.mockClear();
  runUpSpy.mockClear();
  runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
  runUpSpy.mockImplementation(async () => ({ exitCode: 0 }));

  lichHome = mkdtempSync(join(tmpdir(), "lich-restart-test-home-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = lichHome;

  stackPath = mkdtempSync(join(tmpdir(), "stack-restart-test-"));
  writeFileSync(join(stackPath, "lich.yaml"), 'version: "1"\nowned:\n  api:\n    cmd: "echo hi"\n');
});

afterEach(() => {
  runDownSpy.mockReset();
  runUpSpy.mockReset();

  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(lichHome, { recursive: true, force: true });
  rmSync(stackPath, { recursive: true, force: true });
});

afterAll(() => {
  // restore real modules — global mock would leak to later test files
  mock.module("../../../src/commands/down.js", () => ({
    ...realDownModule,
    runDown: realDownModule.runDown,
  }));
  mock.module("../../../src/commands/up.js", () => ({
    ...realUpModule,
    runUp: realUpModule.runUp,
  }));
});

function makeSnapshotForStack(
  stackId: string,
  profile?: string,
  services: ServiceSnapshot[] = [],
): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "main",
    worktree_path: stackPath,
    status: "up",
    started_at: "2026-05-23T10:00:00.000Z",
    services,
    ...(profile !== undefined && { active_profile: profile }),
  };
}

describe("runRestart — happy path: down + up", () => {
  it("invokes runDown first, then runUp, returns exit 0 when both succeed", async () => {
    const order: string[] = [];
    runDownSpy.mockImplementation(async () => {
      order.push("down");
      return { exitCode: 0, warnings: [] };
    });
    runUpSpy.mockImplementation(async () => {
      order.push("up");
      return { exitCode: 0 };
    });

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["down", "up"]);
  });
});

describe("runRestart — down fails: short-circuit before up", () => {
  it("returns down's non-zero exit code WITHOUT calling runUp", async () => {
    runDownSpy.mockImplementation(async () => ({
      exitCode: 2,
      warnings: [{ phase: "stop_owned", message: "boom" }],
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(2);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).not.toHaveBeenCalled();
    expect(result.stackId).toBeUndefined();
    expect(result.services).toBeUndefined();
  });

  it("forwards an arbitrary non-zero down exit (e.g. 7) verbatim", async () => {
    // pin verbatim propagation — guard against future coercion to 1
    runDownSpy.mockImplementation(async () => ({ exitCode: 7, warnings: [] }));

    const result = await runRestart({});
    expect(result.exitCode).toBe(7);
    expect(runUpSpy).not.toHaveBeenCalled();
  });
});

describe("runRestart — down ok, up fails", () => {
  it("returns up's exit code when up fails after a successful down", async () => {
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async () => ({ exitCode: 1, stackId: "abc" }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(1);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    expect(result.stackId).toBe("abc");
  });
});

describe("runRestart — no stack up (down is a tolerant no-op)", () => {
  it("proceeds to up when down returns 0 with 'no stack found' (idempotent)", async () => {
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async () => ({
      exitCode: 0,
      stackId: "fresh-stack",
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    expect(result.stackId).toBe("fresh-stack");
  });
});

describe("runRestart — argument pass-through", () => {
  it("forwards cwd to both runDown and runUp", async () => {
    const cwd = "/tmp/some-worktree";
    await runRestart({ cwd });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({ cwd });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ cwd });
  });

  it("forwards signal to both runDown and runUp", async () => {
    const controller = new AbortController();
    await runRestart({ signal: controller.signal });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("forwards outputMode to both runDown and runUp", async () => {
    await runRestart({ outputMode: "json" });

    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ outputMode: "json" });
    expect(runDownSpy.mock.calls[0][0]).toMatchObject({ outputMode: "json" });
  });

  it("forwards `out` writable stream to both runDown and runUp", async () => {
    const fakeStream = { write: () => true } as unknown as NodeJS.WritableStream;
    await runRestart({ out: fakeStream });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({ out: fakeStream });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ out: fakeStream });
  });
});

describe("runRestart — result-shape pass-through from runUp", () => {
  it("propagates stackId and services from runUp's result", async () => {
    runUpSpy.mockImplementation(async () => ({
      exitCode: 0,
      stackId: "stack-abc",
      services: [
        { name: "api", state: "ready" },
        { name: "web", state: "ready" },
      ],
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(result.stackId).toBe("stack-abc");
    expect(result.services).toEqual([
      { name: "api", state: "ready" },
      { name: "web", state: "ready" },
    ]);
  });

  it("omits stackId/services from result when runUp didn't supply them", async () => {
    runUpSpy.mockImplementation(async () => ({ exitCode: 1 }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(1);
    expect("stackId" in result).toBe(false);
    expect("services" in result).toBe(false);
  });
});

describe("runRestart — AbortSignal mid-flight", () => {
  it("aborts cleanly when signal fires during runDown (down exit propagates)", async () => {
    const controller = new AbortController();
    runDownSpy.mockImplementation(async (input: unknown) => {
      const opts = input as { signal?: AbortSignal };
      controller.abort();
      return {
        exitCode: opts.signal?.aborted ? 130 : 0,
        warnings: [],
      };
    });

    const result = await runRestart({ signal: controller.signal });
    expect(result.exitCode).toBe(130);
    // up must not run after failing down — even a signal-triggered abort —
    // otherwise Ctrl-C mid-restart kicks off an up against in-flight teardown
    expect(runUpSpy).not.toHaveBeenCalled();
  });

  it("aborts cleanly when signal fires during runUp (up exit propagates)", async () => {
    const controller = new AbortController();
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async (input: unknown) => {
      const opts = input as { signal?: AbortSignal };
      controller.abort();
      return { exitCode: opts.signal?.aborted ? 1 : 0 };
    });

    const result = await runRestart({ signal: controller.signal });
    expect(result.exitCode).toBe(1);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
  });
});

describe("runRestart — profile preservation from snapshot", () => {
  it("passes active_profile from the prior snapshot to runUp when no explicit profile given", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(makeSnapshotForStack(wt.stack_id, "dev:lite"));

    await runRestart({ cwd: stackPath });

    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ profile: "dev:lite" });
  });

  it("passes undefined profile to runUp when snapshot has no active_profile", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(makeSnapshotForStack(wt.stack_id));

    await runRestart({ cwd: stackPath });

    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ profile: undefined });
  });

  it("passes undefined profile to runUp when no snapshot exists", async () => {
    await runRestart({ cwd: stackPath });

    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ profile: undefined });
  });

  it("uses explicit profile over snapshot active_profile", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(makeSnapshotForStack(wt.stack_id, "dev:lite"));

    await runRestart({ cwd: stackPath, profile: "dev:fast" });

    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ profile: "dev:fast" });
  });

  it("proceeds gracefully when the worktree has no lich.yaml (no snapshot read attempted)", async () => {
    const noLichDir = mkdtempSync(join(tmpdir(), "no-lich-"));
    try {
      const result = await runRestart({ cwd: noLichDir });
      expect(result.exitCode).toBe(0);
      expect(runUpSpy.mock.calls[0][0]).toMatchObject({ profile: undefined });
    } finally {
      rmSync(noLichDir, { recursive: true, force: true });
    }
  });
});

describe("runRestart — owned snapshot overrides passed to runUp (LEV-527)", () => {
  it("forwards a per-owned-service envOverride map built from snapshot resolved_env / cmd / cwd / stop_cmd", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(
      makeSnapshotForStack(wt.stack_id, undefined, [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          stop_cmd: "echo bye",
          service_cwd: "/abs/api",
          resolved_env: { DATABASE_URL: "postgresql://localhost:12345/d", FOO: "bar" },
        },
        {
          name: "web",
          kind: "owned",
          state: "ready",
          cmd: "bun run web",
          service_cwd: "/abs/web",
          resolved_env: { FOO: "bar" },
        },
      ]),
    );

    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      ownedSnapshotOverrides?: Map<
        string,
        { env: Record<string, string>; cmd: string; cwd: string; stop_cmd?: string }
      >;
    };
    expect(upArg.ownedSnapshotOverrides).toBeInstanceOf(Map);
    const apiOverride = upArg.ownedSnapshotOverrides!.get("api");
    expect(apiOverride).toEqual({
      env: { DATABASE_URL: "postgresql://localhost:12345/d", FOO: "bar" },
      cmd: "bun run dev",
      stop_cmd: "echo bye",
      cwd: "/abs/api",
    });
    const webOverride = upArg.ownedSnapshotOverrides!.get("web");
    expect(webOverride).toEqual({
      env: { FOO: "bar" },
      cmd: "bun run web",
      cwd: "/abs/web",
    });
  });

  it("skips compose services in the overrides map (compose env is regenerated via override file)", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(
      makeSnapshotForStack(wt.stack_id, undefined, [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54321 },
        },
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          service_cwd: "/abs/api",
          resolved_env: { FOO: "bar" },
        },
      ]),
    );

    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      ownedSnapshotOverrides?: Map<string, unknown>;
    };
    expect(upArg.ownedSnapshotOverrides?.has("postgres")).toBe(false);
    expect(upArg.ownedSnapshotOverrides?.has("api")).toBe(true);
  });

  it("omits ownedSnapshotOverrides entirely when snapshot is legacy (no resolved_env on any owned service)", async () => {
    const wt = detectWorktree(stackPath);
    // Legacy: owned service with only name/kind/state — no resolved_env, no cmd, no service_cwd
    await writeSnapshot(
      makeSnapshotForStack(wt.stack_id, undefined, [
        { name: "api", kind: "owned", state: "ready" },
      ]),
    );

    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      ownedSnapshotOverrides?: Map<string, unknown>;
    };
    // Either absent or undefined — the contract is "no override mode" so re-resolution wins
    expect(upArg.ownedSnapshotOverrides).toBeUndefined();
  });

  it("omits an owned service from the overrides map when its snapshot lacks resolved_env (mixed legacy / new)", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(
      makeSnapshotForStack(wt.stack_id, undefined, [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          service_cwd: "/abs/api",
          resolved_env: { FOO: "bar" },
        },
        // legacy entry — must NOT show up in overrides
        { name: "legacy", kind: "owned", state: "ready" },
      ]),
    );

    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      ownedSnapshotOverrides?: Map<string, unknown>;
    };
    expect(upArg.ownedSnapshotOverrides!.has("api")).toBe(true);
    expect(upArg.ownedSnapshotOverrides!.has("legacy")).toBe(false);
  });

  it("omits ownedSnapshotOverrides entirely when no snapshot exists at all", async () => {
    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      ownedSnapshotOverrides?: Map<string, unknown>;
    };
    expect(upArg.ownedSnapshotOverrides).toBeUndefined();
  });

  it("forwards both ownedSnapshotOverrides AND profile in the same call", async () => {
    const wt = detectWorktree(stackPath);
    await writeSnapshot(
      makeSnapshotForStack(wt.stack_id, "dev:fast", [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          cmd: "bun run dev",
          service_cwd: "/abs/api",
          resolved_env: { FOO: "bar" },
        },
      ]),
    );

    await runRestart({ cwd: stackPath });

    const upArg = runUpSpy.mock.calls[0][0] as {
      profile?: string;
      ownedSnapshotOverrides?: Map<string, unknown>;
    };
    expect(upArg.profile).toBe("dev:fast");
    expect(upArg.ownedSnapshotOverrides?.has("api")).toBe(true);
  });
});
