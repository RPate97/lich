import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRuntime } from "../../../src/sandbox/runtime.js";
import { SnapshotStore } from "../../../src/sandbox/snapshot-store.js";
import { goldenName, runName } from "../../../src/sandbox/naming.js";
import { computeBakeInputsHash } from "../../../src/sandbox/inputs-hash.js";
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
  return { backend: "tart", image: "lich-sandbox-base", warm_fork: true, bake_inputs: ["db/migrations/**"], ...overrides };
}

// Mirrors recorded SSH execs into the FakeBackend's ops/env logs so existing
// ordering + env-presence assertions keep working when the lich-up call moves
// from `tart exec` to ssh.
class FakeSshExec {
  exitCode = 0;
  constructor(
    private readonly onExec: (argv: ReadonlyArray<string>, env: Record<string, string>) => void,
  ) {}
  async exec(
    _target: string,
    argv: ReadonlyArray<string>,
    opts: { cwd: string; env: Record<string, string> },
  ): Promise<number> {
    this.onExec(argv, opts.env);
    return this.exitCode;
  }
}

describe("SandboxRuntime", () => {
  let tmp: string;
  let lichYaml: string;
  let backend: FakeBackend;
  let sshExec: FakeSshExec;
  let store: SnapshotStore;
  const ctx = () => ({
    worktreeId: "wt123",
    worktreePath: tmp,
    lichYamlPath: lichYaml,
    profileName: "dev",
  });
  const RUN = runName("wt123", "dev");
  const upOp = `exec:${RUN}:lich up dev`;
  const computeHash = () =>
    computeBakeInputsHash({
      worktreePath: tmp,
      lichYamlPath: lichYaml,
      profileName: "dev",
      bakeInputs: ["db/migrations/**"],
    });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lich-runtime-"));
    lichYaml = join(tmp, "lich.yaml");
    writeFileSync(lichYaml, 'version: "1"\n');
    backend = new FakeBackend();
    sshExec = new FakeSshExec((argv, env) => {
      const op = `exec:${RUN}:${argv.join(" ")}`;
      backend.ops.push(op);
      backend.execEnvByOp[op] = env;
    });
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), "lich-store-")));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const noopSync = {
    async start() {}, async flush() {}, async terminate() {}, async status() { return ""; },
  };

  function runtime(config = makeConfig()) {
    return new SandboxRuntime(config, { backend, snapshotStore: store, bootWaitMs: 0, sync: noopSync as any, sshExec: sshExec as any });
  }

  describe("up", () => {
    it("cold-boots when no golden exists", async () => {
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("cold");
      expect(outcome.vmName).toBe(RUN);
      expect(backend.ops).toContain(`create:${RUN}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).toContain(upOp);
    });

    it("cold boot does not auto-create a golden (snapshot is explicit)", async () => {
      const hash = await computeHash();
      await runtime().up(ctx());
      expect(backend.ops.some((o) => o.startsWith("clone:"))).toBe(false);
      expect(store.findByHash(hash)).toBeUndefined();
    });

    it("warm-forks from an existing stopped golden", async () => {
      const hash = await computeHash();
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
      const hash = await computeHash();
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
      const hash = await computeHash();
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
      expect(backend.ops).toContain(upOp);
      expect(backend.ops).not.toContain(`start:${RUN}`);
    });

    it("restarts a stopped run VM", async () => {
      backend.states.set(RUN, "stopped");
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(`start:${RUN}`);
    });

    it("throws when the in-VM lich up fails", async () => {
      sshExec.exitCode = 1;
      await expect(runtime().up(ctx())).rejects.toThrow(/lich up dev.*exit 1/);
    });

    it("warm-fork records the fork in the store", async () => {
      const hash = await computeHash();
      const golden = goldenName(hash);
      store.upsert({
        inputsHash: hash,
        vmName: golden,
        profileName: "dev",
        lichYamlSnapshot: "",
        createdAt: "2026-05-31T00:00:00Z",
      });
      backend.states.set(golden, "stopped");

      await runtime().up(ctx());

      const forks = store.forks();
      expect(forks.length).toBe(1);
      expect(forks[0]).toMatchObject({ runVm: RUN, goldenHash: hash });
      expect(forks[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("cold-boot does NOT record a fork", async () => {
      await runtime().up(ctx());
      expect(store.forks()).toEqual([]);
    });
  });

  describe("snapshot", () => {
    it("stops the run VM, clones it to a golden, restarts, and records", async () => {
      backend.states.set(RUN, "running");
      const hash = await computeHash();
      const golden = goldenName(hash);

      const result = await runtime().snapshot(ctx());
      expect(result).toBe(golden);
      expect(backend.ops).toContain(`stop:${RUN}`);
      expect(backend.ops).toContain(`clone:${RUN}->${golden}`);
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(store.findByHash(hash)?.vmName).toBe(golden);
    });

    it("default (no opts) restarts the run VM after cloning the golden", async () => {
      backend.states.set(RUN, "running");
      const hash = await computeHash();
      const golden = goldenName(hash);

      await runtime().snapshot(ctx());

      const cloneIdx = backend.ops.indexOf(`clone:${RUN}->${golden}`);
      const startIdx = backend.ops.indexOf(`start:${RUN}`, cloneIdx);
      expect(cloneIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(cloneIdx);
    });

    it("keepStopped: true skips the trailing run-VM restart", async () => {
      backend.states.set(RUN, "running");
      const hash = await computeHash();
      const golden = goldenName(hash);

      await runtime().snapshot(ctx(), { keepStopped: true });

      const cloneIdx = backend.ops.indexOf(`clone:${RUN}->${golden}`);
      const startsAfterClone = backend.ops
        .slice(cloneIdx + 1)
        .filter((o) => o === `start:${RUN}`);
      expect(startsAfterClone).toEqual([]);
    });

    it("throws when there is no run VM to snapshot", async () => {
      await expect(runtime().snapshot(ctx())).rejects.toThrow(/Run 'lich up/);
    });

    it("is a no-op when the golden for this hash already exists in tart", async () => {
      await runtime().up(ctx());
      await runtime().snapshot(ctx());

      const opsBefore = [...backend.ops];
      await runtime().snapshot(ctx());

      const newOps = backend.ops.slice(opsBefore.length);
      expect(newOps.filter(o => o.startsWith("stop:") || o.startsWith("destroy:") || o.startsWith("clone:") || o.startsWith("start:"))).toEqual([]);
    });

    it("snapshot prunes oldest golden after baking a third for the profile", async () => {
      const olderGolden = "old-golden-1";
      const newerGolden = "old-golden-2";
      store.upsert({
        inputsHash: "old1",
        vmName: olderGolden,
        profileName: "dev",
        lichYamlSnapshot: "",
        createdAt: "2026-05-01T00:00:00Z",
      });
      store.upsert({
        inputsHash: "old2",
        vmName: newerGolden,
        profileName: "dev",
        lichYamlSnapshot: "",
        createdAt: "2026-05-15T00:00:00Z",
      });
      backend.states.set(olderGolden, "stopped");
      backend.states.set(newerGolden, "stopped");
      backend.states.set(RUN, "running");

      const config = makeConfig({ gc: { keep_per_profile: 2, max_total_gb: 100 } } as any);
      await runtime(config).snapshot(ctx());

      expect(backend.ops).toContain(`destroy:${olderGolden}`);
      const dev = store.list().filter(g => g.profileName === "dev");
      expect(dev.length).toBe(2);
      expect(dev.find(g => g.vmName === olderGolden)).toBeUndefined();
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

    it("bake-on-down: clones run VM to golden and records manifest when bakeBeforeStop=true", async () => {
      backend.states.set(RUN, "running");
      const hash = await computeHash();
      const golden = goldenName(hash);

      const result = await runtime().down(ctx(), { bakeBeforeStop: true });

      expect(backend.ops).toContain(`clone:${RUN}->${golden}`);
      expect(backend.ops.lastIndexOf(`stop:${RUN}`)).toBeGreaterThan(backend.ops.indexOf(`clone:${RUN}->${golden}`));
      expect(store.findByHash(hash)?.vmName).toBe(golden);
      expect(result.warnings).toEqual([]);
    });

    it("bake-on-down: does NOT restart run VM between clone and final stop (keepStopped)", async () => {
      backend.states.set(RUN, "running");
      const hash = await computeHash();
      const golden = goldenName(hash);

      await runtime().down(ctx(), { bakeBeforeStop: true });

      const cloneIdx = backend.ops.indexOf(`clone:${RUN}->${golden}`);
      const startsAfterClone = backend.ops
        .slice(cloneIdx + 1)
        .filter((o) => o === `start:${RUN}`);
      expect(startsAfterClone).toEqual([]);
    });

    it("bake-on-down: no clone happens when bakeBeforeStop=false (default)", async () => {
      backend.states.set(RUN, "running");
      await runtime().down(ctx());
      expect(backend.ops.some(o => o.startsWith("clone:"))).toBe(false);
    });

    it("bake-on-down: bake failure does NOT block teardown and surfaces a warning", async () => {
      backend.states.set(RUN, "running");
      const origClone = backend.clone.bind(backend);
      backend.clone = async (src: string, dst: string) => {
        backend.ops.push(`clone-FAIL:${src}->${dst}`);
        throw new Error("clone exploded");
      };

      const result = await runtime().down(ctx(), { bakeBeforeStop: true });

      expect(backend.ops.some(o => o.startsWith("clone-FAIL:"))).toBe(true);
      expect(backend.ops).toContain(`stop:${RUN}`);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toMatch(/bake-on-down failed: clone exploded/);
      expect(result.warnings[0]).toMatch(/lich sandbox snapshot/);
      backend.clone = origClone;
    });

    it("bake-on-down: bake failure with purge still destroys", async () => {
      backend.states.set(RUN, "running");
      backend.clone = async () => { throw new Error("nope"); };

      await runtime().down(ctx(), { bakeBeforeStop: true, purge: true });

      expect(backend.ops).toContain(`destroy:${RUN}`);
    });

    it("bake-on-down: skipped when run VM is absent (early return)", async () => {
      await runtime().down(ctx(), { bakeBeforeStop: true });
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
      const rt = new SandboxRuntime(config, { backend, snapshotStore: store, bootWaitMs: 0, sync: sync as any, sshExec: sshExec as any });
      return { rt, sync };
    }

    it("cold path: sync.start runs after start, before in-VM lich up", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      const iStart = backend.ops.indexOf(`start:${RUN}`);
      const iSync = backend.ops.indexOf(`sync.start:${RUN}`);
      const iUp = backend.ops.indexOf(upOp);
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
      expect(backend.execEnvByOp[upOp]?.LICH_SANDBOX_GUEST).toBe("1");
    });

    it("in-VM `lich up` runs with LICH_NO_BROWSER=1 (headless guest has no xdg-open)", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.execEnvByOp[upOp]?.LICH_NO_BROWSER).toBe("1");
    });

    it("in-VM `lich up` runs with LICH_DAEMON_HOST=0.0.0.0 (so host can reach in-VM daemon)", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.execEnvByOp[upOp]?.LICH_DAEMON_HOST).toBe("0.0.0.0");
    });

    it("in-VM `lich up` runs with LICH_HOME=/home/admin/.lich (so ${LICH_HOME} in hooks resolves to a writable path)", async () => {
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.execEnvByOp[upOp]?.LICH_HOME).toBe("/home/admin/.lich");
    });

    it("cold-boot bringUp does NOT set LICH_SKIP_BAKED", async () => {
      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("cold");
      expect(backend.ops).toContain(upOp);
      expect(backend.execEnvByOp[upOp]?.LICH_SKIP_BAKED).toBeUndefined();
    });

    it("warm-fork bringUp sets LICH_SKIP_BAKED=1", async () => {
      const hash = await computeHash();
      const golden = goldenName(hash);
      store.upsert({ inputsHash: hash, vmName: golden, profileName: "dev", lichYamlSnapshot: 'version: "1"\n', createdAt: "t" });
      backend.states.set(golden, "stopped");

      const outcome = await runtime().up(ctx());
      expect(outcome.path).toBe("warm");
      expect(backend.ops).toContain(upOp);
      expect(backend.execEnvByOp[upOp]?.LICH_SKIP_BAKED).toBe("1");
    });

    it("warm-fork clears stale in-VM supervisor state BEFORE the lich up", async () => {
      const hash = await computeHash();
      const golden = goldenName(hash);
      store.upsert({ inputsHash: hash, vmName: golden, profileName: "dev", lichYamlSnapshot: 'version: "1"\n', createdAt: "t" });
      backend.states.set(golden, "stopped");

      await runtime().up(ctx());
      const cleanupIdx = backend.ops.findIndex((o) => o.includes("rm -rf /home/admin/.lich"));
      const upIdx = backend.ops.indexOf(upOp);
      expect(cleanupIdx).toBeGreaterThanOrEqual(0);
      expect(upIdx).toBeGreaterThan(cleanupIdx);
    });

    it("cold-boot does NOT issue a state cleanup (no stale state to clear)", async () => {
      await runtime().up(ctx());
      expect(backend.ops.some((o) => o.includes("rm -rf /home/admin/.lich"))).toBe(false);
    });

    it("re-up does NOT issue a state cleanup (state reflects current truth)", async () => {
      backend.states.set(RUN, "running");
      await runtime().up(ctx());
      expect(backend.ops.some((o) => o.includes("rm -rf /home/admin/.lich"))).toBe(false);
    });

    it("re-up on a running run VM sets LICH_SKIP_BAKED=1", async () => {
      backend.states.set(RUN, "running");
      await runtime().up(ctx());
      expect(backend.execEnvByOp[upOp]?.LICH_SKIP_BAKED).toBe("1");
    });

    it("re-up on a stopped run VM sets LICH_SKIP_BAKED=1", async () => {
      backend.states.set(RUN, "stopped");
      await runtime().up(ctx());
      expect(backend.execEnvByOp[upOp]?.LICH_SKIP_BAKED).toBe("1");
    });

    it("fork path also starts sync", async () => {
      const hash = await computeHash();
      const golden = goldenName(hash);
      store.upsert({ inputsHash: hash, vmName: golden, profileName: "dev", lichYamlSnapshot: "", createdAt: "t" });
      backend.states.set(golden, "stopped");
      const { sync } = withSync();
      await (new SandboxRuntime(makeConfig(), { backend, snapshotStore: store, bootWaitMs: 0, sync: sync as any, sshExec: sshExec as any })).up(ctx());
      expect(sync.startCalls.some((c) => c.name === RUN)).toBe(true);
    });

    it("stopped run-VM path also runs sync.start + in-VM lich up (re-bringUp after restart)", async () => {
      backend.states.set(RUN, "stopped");
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.ops).toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`sync.start:${RUN}`);
      expect(backend.ops).toContain(upOp);
      const iStart = backend.ops.indexOf(`start:${RUN}`);
      const iSync = backend.ops.indexOf(`sync.start:${RUN}`);
      const iUp = backend.ops.indexOf(upOp);
      expect(iSync).toBeGreaterThan(iStart);
      expect(iUp).toBeGreaterThan(iSync);
    });

    it("running run-VM path runs sync.start + in-VM lich up (heals stale state)", async () => {
      backend.states.set(RUN, "running");
      const { rt } = withSync();
      await rt.up(ctx());
      expect(backend.ops).not.toContain(`start:${RUN}`);
      expect(backend.ops).toContain(`sync.start:${RUN}`);
      expect(backend.ops).toContain(upOp);
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
