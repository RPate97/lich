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
  async clone(source: string, dest: string): Promise<void> {
    this.ops.push(`clone:${source}->${dest}`);
    this.states.set(dest, "stopped");
  }
  execEnvByOp: Record<string, Record<string, string> | undefined> = {};
  async exec(name: string, cmd: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    const op = `exec:${name}:${cmd.join(" ")}`;
    this.ops.push(op);
    this.execEnvByOp[op] = opts?.env;
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

function makeConfig(overrides: Partial<SandboxConfigType> = {}): SandboxConfigType {
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

  const noopSync = {
    async start() {}, async flush() {}, async terminate() {}, async status() { return ""; },
  };

  function runtime(config = makeConfig()) {
    return new SandboxRuntime(config, { backend, snapshotStore: store, bootWaitMs: 0, sync: noopSync as any });
  }

  describe("up", () => {
    it("cold-boots when no golden exists", async () => {
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("cold");
      expect(outcome.vmName).toBe(RUN);
      expect(backend.ops).toContain(`create:${RUN}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
    });

    it("cold boot does not auto-create a golden (snapshot is explicit)", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      await runtime().up(ctx());
      expect(backend.ops.some((o) => o.startsWith("clone:"))).toBe(false);
      expect(store.findByHash(hash)).toBeUndefined();
    });

    it("warm-forks from an existing stopped golden", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      store.upsert({
        inputsHash: hash,
        vmName: golden,
        profileName: "dev",
        lichYamlSnapshot: 'version: "1"\n',
        createdAt: "2026-05-30T00:00:00Z",
      });
      backend.states.set(golden, "stopped");

      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`clone:${golden}->${RUN}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).not.toContain(`create:${RUN}`);
    });

    it("ignores the golden when warm_fork is disabled", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      store.upsert({
        inputsHash: hash,
        vmName: golden,
        profileName: "dev",
        lichYamlSnapshot: "",
        createdAt: "t",
      });
      backend.states.set(golden, "stopped");

      const outcome = await runtime(makeConfig({ warm_fork: false })).up(ctx());
      expect(outcome.path).toBe("cold");
      expect(backend.ops).toContain(`create:${RUN}`);
    });

    it("drops a stale golden entry whose VM is gone, then cold-boots", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      store.upsert({
        inputsHash: hash,
        vmName: golden,
        profileName: "dev",
        lichYamlSnapshot: "",
        createdAt: "t",
      });
      // Golden VM absent from backend.
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("cold");
      expect(store.findByHash(hash)).toBeUndefined();
    });

    it("re-brings-up an already-running run VM (heals drift; safe on idempotent stack)", async () => {
      backend.states.set(RUN, "running");
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
      expect(backend.ops).not.toContain(`start:${RUN}`);
    });

    it("restarts a stopped run VM", async () => {
      backend.states.set(RUN, "stopped");
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`start:${RUN}`);
    });

    it("throws when the in-VM lich up fails", async () => {
      backend.exec = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
      await expect(runtime().up(ctx())).rejects.toThrow(/lich up dev.*exit 1/);
    });
  });

  describe("snapshot", () => {
    it("stops the run VM, clones it to a golden, restarts, and records", async () => {
      backend.states.set(RUN, "running");
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);

      const result = await runtime().snapshot(ctx());
      expect(result).toBe(golden);
      expect(backend.ops).toContain(`stop:${RUN}`);
      expect(backend.ops).toContain(`clone:${RUN}->${golden}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(store.findByHash(hash)?.vmName).toBe(golden);
    });

    it("throws when there is no run VM to snapshot", async () => {
      await expect(runtime().snapshot(ctx())).rejects.toThrow(/Run 'lich up/);
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
      await expect(runtime().exec(ctx(), ["lich", "logs"])).rejects.toThrow(/Run 'lich up/);
    });
  });

  describe("source sync", () => {
    class FakeSync {
      startCalls: any[] = [];
      constructor(private readonly log: string[]) {}
      async start(opts: any) { this.log.push(`sync.start:${opts.name}`); this.startCalls.push(opts); }
      async flush(name: string) { this.log.push(`sync.flush:${name}`); }
      async terminate(name: string) { this.log.push(`sync.terminate:${name}`); }
      async status() { return ""; }
    }

    function withSync(config = makeConfig()) {
      const sync = new FakeSync(backend.ops);
      const rt = new SandboxRuntime(config, { backend, snapshotStore: store, bootWaitMs: 0, sync: sync as any });
      return { rt, sync };
    }

    it("cold path: sync.start runs after start, before in-VM lich up", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      const iStart = backend.ops.indexOf(`start:${RUN}`);
      const iSync = backend.ops.indexOf(`sync.start:${RUN}`);
      const iUp = backend.ops.indexOf(`exec:${RUN}:lich up dev`);
      expect(iStart).toBeGreaterThanOrEqual(0);
      expect(iSync).toBeGreaterThan(iStart);
      expect(iUp).toBeGreaterThan(iSync);
    });

    it("sync ignore list always contains node_modules; guest path is /workspace", async () => {
      const { rt, sync } = withSync();
      await rt.up(ctx());
      expect(sync.startCalls[0].ignore).toContain("node_modules");
      expect(sync.startCalls[0].guestPath).toBe("/workspace");
      expect(sync.startCalls[0].hostPath).toBe(tmp);
    });

    it("in-VM `lich up` runs with LICH_SANDBOX_GUEST=1 (nesting guard)", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.execEnvByOp[`exec:${RUN}:lich up dev`]?.LICH_SANDBOX_GUEST).toBe("1");
    });

    it("in-VM `lich up` runs with LICH_NO_BROWSER=1 (headless guest has no xdg-open)", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.execEnvByOp[`exec:${RUN}:lich up dev`]?.LICH_NO_BROWSER).toBe("1");
    });

    it("fork path also starts sync", async () => {
      const hash = computeInputsHash(lichYaml, "dev");
      const golden = goldenName(hash);
      store.upsert({ inputsHash: hash, vmName: golden, profileName: "dev", lichYamlSnapshot: "", createdAt: "t" });
      backend.states.set(golden, "stopped");
      const { sync } = withSync();
      await (new SandboxRuntime(makeConfig(), { backend, snapshotStore: store, bootWaitMs: 0, sync: sync as any })).up(ctx());
      expect(sync.startCalls.some((c) => c.name === RUN)).toBe(true);
    });

    it("stopped run-VM path also runs sync.start + in-VM lich up (re-bringUp after restart)", async () => {
      backend.states.set(RUN, "stopped");
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`sync.start:${RUN}`);
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
      const iStart = backend.ops.indexOf(`start:${RUN}`);
      const iSync = backend.ops.indexOf(`sync.start:${RUN}`);
      const iUp = backend.ops.indexOf(`exec:${RUN}:lich up dev`);
      expect(iSync).toBeGreaterThan(iStart);
      expect(iUp).toBeGreaterThan(iSync);
    });

    it("running run-VM path runs sync.start + in-VM lich up (heals stale state)", async () => {
      backend.states.set(RUN, "running");
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.ops).not.toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`sync.start:${RUN}`);
      expect(backend.ops).toContain(`exec:${RUN}:lich up dev`);
    });

    it("down terminates the sync session", async () => {
      backend.states.set(RUN, "running");
      const { rt } = withSync();
      await rt.down(ctx());
      expect(backend.ops).toContain(`sync.terminate:${RUN}`);
    });

    it("config sync.ignore is unioned into the resolved ignore list", async () => {
      const { rt, sync } = withSync(makeConfig({ sync: { ignore: ["coverage"] } } as any));
      await rt.up(ctx());
      expect(sync.startCalls[0].ignore).toContain("coverage");
      expect(sync.startCalls[0].ignore).toContain("node_modules");
    });

    it("up() returns vmIp from backend.ip()", async () => {
      const { rt } = withSync();
      const outcome = await rt.up(ctx());
      expect(outcome.vmIp).toBe("10.0.0.1");
    });

    it("scrapeInVmStack returns the parsed StackView for the active profile", async () => {
      const { rt } = withSync();
      backend.exec = async (_name, cmd) => {
        if (cmd.join(" ") === "lich stacks --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ id: "workspace-c52ddf65", worktree_name: "workspace", status: "up", services: [{ name: "web", state: "ready", allocated_ports: { PORT: 8088 } }] }]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const scraped = await rt.scrapeInVmStack(ctx(), runName("wt123", "dev"));
      expect(scraped?.id).toBe("workspace-c52ddf65");
      expect(scraped?.services[0]!.name).toBe("web");
    });
  });
});
