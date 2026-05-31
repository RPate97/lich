import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRuntime } from "../../../src/sandbox/runtime.js";
import { SnapshotStore } from "../../../src/sandbox/snapshot-store.js";
import { goldenName, runName } from "../../../src/sandbox/naming.js";
import { computeInputsHash } from "../../../src/sandbox/inputs-hash.js";
import type {
  SandboxBackend,
  SandboxConfig,
  SandboxState,
  ExecResult,
  ExecOptions,
} from "../../../src/sandbox/backend.js";
import type { SandboxRuntime as SandboxConfigType } from "../../../src/config/types.js";

class FakeBackend implements SandboxBackend {
  ops: string[] = [];
  states = new Map<string, SandboxState["state"]>();

  async create(config: SandboxConfig): Promise<void> {
    this.ops.push(`create:${config.name}`);
    this.states.set(config.name, "stopped");
  }
  async start(name: string): Promise<void> {
    this.ops.push(`start:${name}`);
    this.states.set(name, "running");
  }
  async stop(name: string): Promise<void> {
    this.ops.push(`stop:${name}`);
    this.states.set(name, "stopped");
  }
  async destroy(name: string): Promise<void> {
    this.ops.push(`destroy:${name}`);
    this.states.delete(name);
  }
  async suspend(name: string): Promise<void> {
    this.ops.push(`suspend:${name}`);
    this.states.set(name, "suspended");
  }
  async resume(name: string): Promise<void> {
    this.ops.push(`resume:${name}`);
    this.states.set(name, "running");
  }
  async clone(source: string, dest: string): Promise<void> {
    this.ops.push(`clone:${source}->${dest}`);
    this.states.set(dest, "suspended");
  }
  async exec(
    name: string,
    cmd: readonly string[],
    _opts?: ExecOptions,
  ): Promise<ExecResult> {
    this.ops.push(`exec:${name}:${cmd.join(" ")}`);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async ip(): Promise<string> {
    return "10.0.0.1";
  }
  async list(): Promise<readonly SandboxState[]> {
    return [...this.states.entries()].map(([name, state]) => ({ name, state }));
  }
  async inspect(name: string): Promise<SandboxState> {
    return { name, state: this.states.get(name) ?? "absent" };
  }
}

function makeConfig(
  overrides: Partial<SandboxConfigType> = {},
): SandboxConfigType {
  return { backend: "tart", image: "lich-sandbox-base", warm_fork: true, ...overrides };
}

describe("SandboxRuntime", () => {
  let tmp: string;
  let lichYaml: string;
  let backend: FakeBackend;
  let store: SnapshotStore;
  const ctx = () => ({
    worktreeId: "wt123",
    worktreePath: tmp,
    lichYamlPath: lichYaml,
    profileName: "dev",
  });
  const RUN = runName("wt123", "dev");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lich-runtime-"));
    lichYaml = join(tmp, "lich.yaml");
    writeFileSync(lichYaml, 'version: "1"\n');
    backend = new FakeBackend();
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), "lich-store-")));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runtime(config = makeConfig()) {
    return new SandboxRuntime(config, { backend, snapshotStore: store, sshWaitMs: 0 });
  }

  describe("up", () => {
    it("cold-boots when no golden exists and warm_fork enabled", async () => {
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("cold");
      expect(outcome.vmName).toBe(RUN);
      expect(backend.ops).toContain(`create:${RUN}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
    });

    it("snapshots the run VM into a golden after a cold boot", async () => {
      await runtime().up(ctx());
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      expect(backend.ops).toContain(`suspend:${RUN}`);
      expect(backend.ops).toContain(`clone:${RUN}->${golden}`);
      expect(backend.ops).toContain(`resume:${RUN}`);
      expect(store.findByHash(hash)?.vmName).toBe(golden);
    });

    it("warm-forks from an existing golden without re-running lich up", async () => {
      // Seed a golden into both the store and the backend (suspended).
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      store.upsert({
        inputsHash: hash,
        vmName: golden,
        profileName: "dev",
        lichYamlSnapshot: 'version: "1"\n',
        createdAt: "2026-05-30T00:00:00Z",
      });
      backend.states.set(golden, "suspended");

      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`clone:${golden}->${RUN}`);
      expect(backend.ops).toContain(`resume:${RUN}`);
      expect(backend.ops.some((o) => o.startsWith(`exec:${RUN}:lich up`))).toBe(false);
    });

    it("is idempotent when the run VM is already running", async () => {
      backend.states.set(RUN, "running");
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toEqual([]);
    });

    it("resumes a suspended run VM", async () => {
      backend.states.set(RUN, "suspended");
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`resume:${RUN}`);
    });

    it("does not snapshot a golden when warm_fork is disabled", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      const outcome = await runtime(makeConfig({ warm_fork: false })).up(ctx());
      expect(outcome.path).toBe("cold");
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
      expect(backend.ops.some((o) => o.startsWith("clone:"))).toBe(false);
      expect(store.findByHash(hash)).toBeUndefined();
    });

    it("throws when the in-VM lich up fails", async () => {
      backend.exec = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
      await expect(runtime().up(ctx())).rejects.toThrow(/lich up dev.*exit 1/);
    });
  });

  describe("down", () => {
    it("runs in-VM lich down then stops the run VM by default", async () => {
      backend.states.set(RUN, "running");
      await runtime().down(ctx());
      expect(backend.ops).toContain(`exec:${RUN}:lich down`);
      expect(backend.ops).toContain(`stop:${RUN}`);
      expect(backend.ops).not.toContain(`destroy:${RUN}`);
    });

    it("destroys the run VM when purge is set", async () => {
      backend.states.set(RUN, "running");
      await runtime().down(ctx(), { purge: true });
      expect(backend.ops).toContain(`destroy:${RUN}`);
      expect(backend.ops).not.toContain(`stop:${RUN}`);
    });

    it("is a no-op when the run VM is absent", async () => {
      await runtime().down(ctx());
      expect(backend.ops).toEqual([]);
    });
  });

  describe("exec", () => {
    it("proxies into the running run VM", async () => {
      backend.states.set(RUN, "running");
      const result = await runtime().exec(ctx(), ["lich", "logs"]);
      expect(result.exitCode).toBe(0);
      expect(backend.ops).toContain(`exec:${RUN}:lich logs`);
    });

    it("throws when the run VM is absent", async () => {
      await expect(runtime().exec(ctx(), ["lich", "logs"])).rejects.toThrow(/run 'lich up'/);
    });
  });
});
