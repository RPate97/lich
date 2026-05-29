import { describe, expect, it, vi } from "vitest";

import {
  cascadeKillSiblings,
  killOthersEnabled,
} from "../../../src/commands/up.js";
import { _exec as composeExec } from "../../../src/compose/runner.js";

describe("killOthersEnabled — runtime flag", () => {
  it("returns true when runtime is undefined (default ON)", () => {
    expect(killOthersEnabled(undefined)).toBe(true);
  });

  it("returns true when runtime is set but kill_others_on_fail is unset (default ON)", () => {
    // unrelated runtime blocks must not silently flip the cascade off
    expect(killOthersEnabled({ compose_cli: "docker" })).toBe(true);
  });

  it("returns true when kill_others_on_fail is explicitly true", () => {
    expect(killOthersEnabled({ kill_others_on_fail: true })).toBe(true);
  });

  it("returns false when kill_others_on_fail is explicitly false (opt-out)", () => {
    expect(killOthersEnabled({ kill_others_on_fail: false })).toBe(false);
  });
});

interface FakeHandle {
  stop: (graceMs?: number) => Promise<void>;
  stopMock: ReturnType<typeof vi.fn>;
}
function makeFakeHandle(): FakeHandle {
  const stopMock = vi.fn() as ReturnType<typeof vi.fn> & {
    (graceMs?: number): Promise<void>;
  };
  stopMock.mockImplementation(async () => undefined);
  return {
    stop: (graceMs?: number): Promise<void> =>
      stopMock(graceMs) as Promise<void>,
    stopMock,
  };
}

function makeServiceMap(
  entries: Array<{ name: string; kind: "compose" | "owned"; state: string }>,
): Map<string, { name: string; kind: "compose" | "owned"; state: string }> {
  const m = new Map<
    string,
    { name: string; kind: "compose" | "owned"; state: string }
  >();
  for (const e of entries) m.set(e.name, e);
  return m;
}

describe("cascadeKillSiblings — startup-race teardown", () => {
  it("stops every in-flight owned sibling (excluding the failed one)", async () => {
    const apiHandle = makeFakeHandle();
    const webHandle = makeFakeHandle();
    const workerHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof apiHandle>([
      ["api", apiHandle],
      ["web", webHandle],
      ["worker", workerHandle],
    ]);
    const services = makeServiceMap([
      { name: "api", kind: "owned", state: "failed" },
      { name: "web", kind: "owned", state: "ready" },
      { name: "worker", kind: "owned", state: "ready" },
    ]);

    const killed = await cascadeKillSiblings({
      ownedHandles,
      services,
      failedNames: new Set(["api"]),
      composeCtx: null,
    });

    // failed service excluded — it's already dead, and shouldn't show in
    // the cascade summary as "killed" (it failed, not cascade-killed)
    expect(killed).toEqual(["web", "worker"]);
    expect(apiHandle.stopMock).not.toHaveBeenCalled();
    expect(webHandle.stopMock).toHaveBeenCalledTimes(1);
    expect(workerHandle.stopMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when no siblings are in flight", async () => {
    const apiHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof apiHandle>([
      ["api", apiHandle],
    ]);
    const services = makeServiceMap([
      { name: "api", kind: "owned", state: "failed" },
    ]);

    const killed = await cascadeKillSiblings({
      ownedHandles,
      services,
      failedNames: new Set(["api"]),
      composeCtx: null,
    });

    expect(killed).toEqual([]);
    expect(apiHandle.stopMock).not.toHaveBeenCalled();
  });

  it("issues a single project-level `compose down` when any compose services started", async () => {
    const apiHandle = makeFakeHandle();
    const webHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof apiHandle>([
      ["api", apiHandle],
      ["web", webHandle],
    ]);
    const services = makeServiceMap([
      { name: "api", kind: "owned", state: "failed" },
      { name: "web", kind: "owned", state: "ready" },
      { name: "postgres", kind: "compose", state: "ready" },
    ]);

    const composeCalls: Array<{ cmd: string; args: string[] }> = [];
    const originalExec = composeExec.current;
    composeExec.current = async (cmd, args) => {
      composeCalls.push({ cmd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const killed = await cascadeKillSiblings({
        ownedHandles,
        services,
        failedNames: new Set(["api"]),
        composeCtx: {
          cli: { kind: "docker", cmd: "docker", args: ["compose"] },
          project: "lich-abc123",
          files: ["/path/to/override.yaml"],
          cwd: "/path/to/worktree",
        },
      });

      expect(killed).toEqual(["postgres", "web"]);
      expect(webHandle.stopMock).toHaveBeenCalledTimes(1);
      expect(composeCalls).toHaveLength(1);
      const call = composeCalls[0];
      expect(call.cmd).toBe("docker");
      expect(call.args).toContain("-p");
      expect(call.args).toContain("lich-abc123");
      expect(call.args).toContain("down");
      // NOT -v on cascade — that's destructive and reserved for `lich down`
      expect(call.args).not.toContain("-v");
    } finally {
      composeExec.current = originalExec;
    }
  });

  it("skips the compose teardown when composeCtx is null", async () => {
    const apiHandle = makeFakeHandle();
    const webHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof apiHandle>([
      ["api", apiHandle],
      ["web", webHandle],
    ]);
    const services = makeServiceMap([
      { name: "api", kind: "owned", state: "failed" },
      { name: "web", kind: "owned", state: "ready" },
    ]);

    let composeCalled = false;
    const originalExec = composeExec.current;
    composeExec.current = async () => {
      composeCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const killed = await cascadeKillSiblings({
        ownedHandles,
        services,
        failedNames: new Set(["api"]),
        composeCtx: null,
      });

      expect(killed).toEqual(["web"]);
      expect(webHandle.stopMock).toHaveBeenCalledTimes(1);
      expect(composeCalled).toBe(false);
    } finally {
      composeExec.current = originalExec;
    }
  });

  it("skips compose services that haven't started yet (state: starting)", async () => {
    const apiHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof apiHandle>([
      ["api", apiHandle],
    ]);
    const services = makeServiceMap([
      { name: "postgres", kind: "compose", state: "ready" },
      { name: "api", kind: "owned", state: "failed" },
      { name: "worker", kind: "compose", state: "starting" },
    ]);

    const composeCalls: Array<{ cmd: string; args: string[] }> = [];
    const originalExec = composeExec.current;
    composeExec.current = async (cmd, args) => {
      composeCalls.push({ cmd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const killed = await cascadeKillSiblings({
        ownedHandles,
        services,
        failedNames: new Set(["api"]),
        composeCtx: {
          cli: { kind: "docker", cmd: "docker", args: ["compose"] },
          project: "lich-xyz",
          files: [],
          cwd: "/path/to/worktree",
        },
      });

      expect(killed).toEqual(["postgres"]);
      expect(composeCalls).toHaveLength(1);
    } finally {
      composeExec.current = originalExec;
    }
  });

  it("swallows owned-handle stop errors so one bad sibling doesn't block the others", async () => {
    const goodHandle = makeFakeHandle();
    const badStopMock = vi.fn() as ReturnType<typeof vi.fn> & {
      (graceMs?: number): Promise<void>;
    };
    badStopMock.mockImplementation(async () => {
      throw new Error("supervisor bug: stop_cmd ENOENT");
    });
    const badHandle: FakeHandle = {
      stop: (graceMs?: number): Promise<void> =>
        badStopMock(graceMs) as Promise<void>,
      stopMock: badStopMock,
    };
    const ownedHandles = new Map<string, FakeHandle>([
      ["good", goodHandle],
      ["bad", badHandle],
    ]);
    const services = makeServiceMap([
      { name: "good", kind: "owned", state: "ready" },
      { name: "bad", kind: "owned", state: "ready" },
    ]);

    const killed = await cascadeKillSiblings({
      ownedHandles,
      services,
      failedNames: new Set(),
      composeCtx: null,
    });

    expect(killed).toEqual(["bad", "good"]);
    expect(goodHandle.stopMock).toHaveBeenCalledTimes(1);
    expect(badHandle.stopMock).toHaveBeenCalledTimes(1);
  });

  it("swallows compose-down errors so the user still sees the cascade list", async () => {
    const ownedHandle = makeFakeHandle();
    const ownedHandles = new Map<string, typeof ownedHandle>([
      ["worker", ownedHandle],
    ]);
    const services = makeServiceMap([
      { name: "worker", kind: "owned", state: "ready" },
      { name: "postgres", kind: "compose", state: "ready" },
    ]);

    const originalExec = composeExec.current;
    composeExec.current = async () => {
      throw new Error("docker daemon not responding");
    };

    try {
      const killed = await cascadeKillSiblings({
        ownedHandles,
        services,
        failedNames: new Set(),
        composeCtx: {
          cli: { kind: "docker", cmd: "docker", args: ["compose"] },
          project: "lich-broken",
          files: [],
          cwd: "/path/to/worktree",
        },
      });

      // killed reflects "we attempted to kill these" — caller already
      // knows things may be in a weird state on the failure path
      expect(killed).toEqual(["postgres", "worker"]);
      expect(ownedHandle.stopMock).toHaveBeenCalledTimes(1);
    } finally {
      composeExec.current = originalExec;
    }
  });
});
