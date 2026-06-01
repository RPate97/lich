import { describe, it, expect } from "vitest";
import { SandboxStackExecutor } from "../../../../src/stack/executors/sandbox-tart.js";

class FakeRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async down(...args: unknown[]) { this.calls.push({ method: "down", args }); }
  async exec(...args: unknown[]) {
    this.calls.push({ method: "exec", args });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async up(...args: unknown[]) {
    this.calls.push({ method: "up", args });
    return { path: "cold", vmName: "lich-run-x", durationMs: 100 };
  }
}

const fakeCtx = () => ({
  worktreeId: "wt1",
  worktreePath: "/work/x",
  lichYamlPath: "/work/x/lich.yaml",
  profileName: "dev",
});

describe("SandboxStackExecutor.down", () => {
  it("calls runtime.down with purge:true when input.purge is set", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx());
    await exe.down({ purge: true, outputMode: "pretty" });
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: true });
  });

  it("calls runtime.down with purge:false otherwise", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx());
    await exe.down({ outputMode: "pretty" } as any);
    expect(rt.calls[0]!.args[1]).toEqual({ purge: false });
  });
});

describe("SandboxStackExecutor.exec", () => {
  it("proxies user argv as 'lich exec -- <args>' with inheritStdio", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx());
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
    const exe = new SandboxStackExecutor(rt as any, fakeCtx());
    const result = exe.logs({ sources: ["api"], follow: true, count: 100, all: false, json: false } as any);
    await result.done;
    const [, args, opts] = rt.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(["lich", "logs", "api", "--follow"]);
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.inheritStdio).toBe(true);
  });

  it("proxies non-follow logs with --no-follow --tail N + 30s timeout", async () => {
    const rt = new FakeRuntime();
    const exe = new SandboxStackExecutor(rt as any, fakeCtx());
    const result = exe.logs({ sources: [], follow: false, count: 50, all: false, json: false } as any);
    await result.done;
    const [, args, opts] = rt.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(["lich", "logs", "--no-follow", "--tail", "50"]);
    expect(opts.timeoutMs).toBe(30_000);
  });
});
