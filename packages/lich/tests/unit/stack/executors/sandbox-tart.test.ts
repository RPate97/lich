import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxStackExecutor } from "../../../../src/stack/executors/sandbox-tart.js";
import { readSnapshot } from "../../../../src/state/snapshot.js";

class FakeRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  downWarnings: string[] = [];
  async down(...args: unknown[]) {
    this.calls.push({ method: "down", args });
    return { warnings: this.downWarnings };
  }
  async exec(...args: unknown[]) {
    this.calls.push({ method: "exec", args });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async up(...args: unknown[]) {
    this.calls.push({ method: "up", args });
    return { path: "cold", vmName: "lich-run-x", vmIp: "10.0.0.1", durationMs: 100 };
  }
  async scrapeInVmStack(...args: unknown[]): Promise<unknown> {
    this.calls.push({ method: "scrapeInVmStack", args });
    return null;
  }
}

const fakeCtx = () => ({
  worktreeId: "wt1",
  worktreePath: "/work/x",
  lichYamlPath: "/work/x/lich.yaml",
  profileName: "dev",
});

const fakeDeps = () => ({
  worktree: { name: "x", id: "wt1", path: "/work/x", stack_id: "x-wt1" } as any,
});

describe("SandboxStackExecutor.down", () => {
  it("calls runtime.down with purge:true when input.purge is set", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { ...fakeDeps(), warmForkEnabled: true });
    await exe.down({ purge: true, outputMode: "pretty" });
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: true, bakeBeforeStop: true });
  });

  it("calls runtime.down with purge:false otherwise", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { ...fakeDeps(), warmForkEnabled: true });
    await exe.down({ outputMode: "pretty" } as any);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: false, bakeBeforeStop: true });
  });

  it("passes bakeBeforeStop:false when warmForkEnabled is false", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { ...fakeDeps(), warmForkEnabled: false });
    await exe.down({ outputMode: "pretty" } as any);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: false, bakeBeforeStop: false });
  });

  it("surfaces runtime down warnings via RunDownResult.warnings and writes them to out", async () => {
    const rt = new FakeRuntime();
    rt.downWarnings = ["bake-on-down failed: boom (run `lich sandbox snapshot` to retry)"];
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { ...fakeDeps(), warmForkEnabled: true });
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c) => chunks.push(c));
    const result = await exe.down({ outputMode: "pretty", out: sink } as any);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({ phase: "bake_on_down", message: rt.downWarnings[0] });
    expect(Buffer.concat(chunks).toString()).toMatch(/warning: bake-on-down failed: boom/);
  });

  it("returns empty warnings when runtime reports no warnings", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { ...fakeDeps(), warmForkEnabled: true });
    const result = await exe.down({ outputMode: "pretty" } as any);
    expect(result.warnings).toEqual([]);
  });
});

describe("SandboxStackExecutor.exec", () => {
  it("proxies user argv as 'lich exec -- <args>' with inheritStdio", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    const result = await exe.exec({ argv: ["api", "ls", "-la"] } as any);
    expect(result.exitCode).toBe(0);
    const [, args, opts] = rt.calls[0]!.args as [unknown, string[], unknown];
    expect(args).toEqual(["lich", "exec", "--", "api", "ls", "-la"]);
    expect(opts).toEqual({ inheritStdio: true });
  });
});

describe("SandboxStackExecutor.logs", () => {
  it("proxies 'lich logs <sources> --follow' with no timeout when follow=true", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    const result = exe.logs({ sources: ["api"], follow: true, count: 100, all: false, json: false } as any);
    await result.done;
    const [, args, opts] = rt.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(["lich", "logs", "api", "--follow"]);
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.inheritStdio).toBe(true);
  });

  it("proxies non-follow logs with --no-follow --tail N + 30s timeout", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    const result = exe.logs({ sources: [], follow: false, count: 50, all: false, json: false } as any);
    await result.done;
    const [, args, opts] = rt.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(["lich", "logs", "--no-follow", "--tail", "50"]);
    expect(opts.timeoutMs).toBe(30_000);
  });

  it("omits --tail when count is 0 (parity with old maybeRouteToSandbox guard)", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    const result = exe.logs({ sources: [], follow: false, count: 0, all: false, json: false } as any);
    await result.done;
    const [, args] = rt.calls[0]!.args as [unknown, string[], any];
    expect(args).not.toContain("--tail");
  });
});

describe("SandboxStackExecutor.up", () => {
  it("writes host snapshot with data_source, executor, services mirror, and routing entries", async () => {
    class FakeRuntimeWithScrape extends FakeRuntime {
      override async up(...args: unknown[]) {
        this.calls.push({ method: "up", args });
        return { path: "cold" as const, vmName: "lich-run-x", vmIp: "10.0.0.5", durationMs: 100 };
      }
      override async scrapeInVmStack(_ctx: any, _vm: string) {
        return {
          id: "workspace-c52ddf65",
          worktree_name: "workspace",
          status: "up",
          services: [{ name: "web", kind: "owned" as const, state: "ready", ports: { PORT: 8088 } }],
        };
      }
    }

    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-up-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntimeWithScrape();
      const wt = { name: "demo", id: "abc12345", path: "/work/demo", stack_id: "demo-abc12345" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      const result = await exe.up({ outputMode: "pretty" } as any);
      expect(result.exitCode).toBe(0);
      const snap = await readSnapshot("demo-abc12345");
      expect(snap?.executor).toEqual({ kind: "sandbox-tart", vm_name: "lich-run-x" });
      expect(snap?.data_source).toEqual({ kind: "http", base_url: "http://10.0.0.5:3300", stack_id: "workspace-c52ddf65" });
      expect(snap?.services).toHaveLength(1);
      expect(snap?.services[0]!.name).toBe("web");
      expect(snap?.routing).toHaveLength(1);
      expect(snap?.routing![0]!).toEqual({ hostname: "web.demo", upstream_url: "http://10.0.0.5:8088", service: "web" });
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the in-VM daemon's actual API port for data_source.base_url when scrape succeeds", async () => {
    class FakeRuntimeWithDaemonScrape extends FakeRuntime {
      override async up(...args: unknown[]) {
        this.calls.push({ method: "up", args });
        return { path: "cold" as const, vmName: "lich-run-x", vmIp: "10.0.0.5", durationMs: 100 };
      }
      override async scrapeInVmStack(_ctx: any, _vm: string) {
        return {
          id: "workspace-c52ddf65",
          worktree_name: "workspace",
          status: "up",
          services: [{ name: "web", kind: "owned" as const, state: "ready", ports: { PORT: 8088 } }],
        };
      }
      async scrapeInVmDaemonPort(_vm: string): Promise<number | null> {
        return 38165;
      }
    }
    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-port-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntimeWithDaemonScrape();
      const wt = { name: "demo", id: "abc12345", path: "/work/demo", stack_id: "demo-abc12345" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      await exe.up({ outputMode: "pretty" } as any);
      const snap = await readSnapshot("demo-abc12345");
      expect(snap?.data_source).toEqual({ kind: "http", base_url: "http://10.0.0.5:38165", stack_id: "workspace-c52ddf65" });
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to :3300 in data_source.base_url when daemon-port scrape returns null", async () => {
    class FakeRuntimeWithNullDaemonScrape extends FakeRuntime {
      override async up(...args: unknown[]) {
        this.calls.push({ method: "up", args });
        return { path: "cold" as const, vmName: "lich-run-x", vmIp: "10.0.0.5", durationMs: 100 };
      }
      override async scrapeInVmStack(_ctx: any, _vm: string) {
        return {
          id: "workspace-c52ddf65",
          worktree_name: "workspace",
          status: "up",
          services: [{ name: "web", kind: "owned" as const, state: "ready", ports: { PORT: 8088 } }],
        };
      }
      async scrapeInVmDaemonPort(_vm: string): Promise<number | null> {
        return null;
      }
    }
    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-port-fb-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntimeWithNullDaemonScrape();
      const wt = { name: "demo", id: "abc12345", path: "/work/demo", stack_id: "demo-abc12345" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      await exe.up({ outputMode: "pretty" } as any);
      const snap = await readSnapshot("demo-abc12345");
      expect(snap?.data_source).toEqual({ kind: "http", base_url: "http://10.0.0.5:3300", stack_id: "workspace-c52ddf65" });
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns exitCode 0 and stackId from deps.worktree when scrape returns null", async () => {
    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-up-null-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntime();
      const wt = { name: "x", id: "wt1", path: "/work/x", stack_id: "x-wt1" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      const result = await exe.up({ outputMode: "pretty" } as any);
      expect(result.exitCode).toBe(0);
      expect(result.stackId).toBe("x-wt1");
      const snap = await readSnapshot("x-wt1");
      expect(snap?.data_source).toEqual({ kind: "local" });
      expect(snap?.services).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes cold-booted status line to input.out", async () => {
    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-up-out-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntime();
      const wt = { name: "x", id: "wt1", path: "/work/x", stack_id: "x-wt1" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on("data", (c) => chunks.push(c));
      await exe.up({ outputMode: "pretty", out: sink } as any);
      const output = Buffer.concat(chunks).toString();
      expect(output).toMatch(/sandbox VM 'lich-run-x' cold-booted in \d+ms/);
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes warm-forked status line when outcome.path is warm", async () => {
    class FakeRuntimeWarm extends FakeRuntime {
      override async up(...args: unknown[]) {
        this.calls.push({ method: "up", args });
        return { path: "warm" as const, vmName: "lich-run-w", vmIp: "10.0.0.2", durationMs: 42 };
      }
    }
    const home = mkdtempSync(join(tmpdir(), "lich-sandbox-up-warm-"));
    const prev = process.env.LICH_HOME;
    process.env.LICH_HOME = home;
    try {
      const rt = new FakeRuntimeWarm();
      const wt = { name: "x", id: "wt1", path: "/work/x", stack_id: "x-wt1" };
      const exe = new SandboxStackExecutor(rt as any, fakeCtx(), { worktree: wt as any });
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on("data", (c) => chunks.push(c));
      await exe.up({ outputMode: "pretty", out: sink } as any);
      const output = Buffer.concat(chunks).toString();
      expect(output).toMatch(/sandbox VM 'lich-run-w' warm-forked in 42ms/);
    } finally {
      if (prev === undefined) delete process.env.LICH_HOME;
      else process.env.LICH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
