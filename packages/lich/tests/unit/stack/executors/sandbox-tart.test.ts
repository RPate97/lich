import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxStackExecutor } from "../../../../src/stack/executors/sandbox-tart.js";
import { readSnapshot } from "../../../../src/state/snapshot.js";

class FakeRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async down(...args: unknown[]) { this.calls.push({ method: "down", args }); }
  async exec(...args: unknown[]) {
    this.calls.push({ method: "exec", args });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async up(...args: unknown[]) {
    this.calls.push({ method: "up", args });
    return { path: "cold", vmName: "lich-run-x", vmIp: "10.0.0.1", durationMs: 100 };
  }
  async scrapeInVmStack(...args: unknown[]) {
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
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    await exe.down({ purge: true, outputMode: "pretty" });
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: true });
  });

  it("calls runtime.down with purge:false otherwise", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx(), fakeDeps());
    await exe.down({ outputMode: "pretty" } as any);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: false });
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
});
