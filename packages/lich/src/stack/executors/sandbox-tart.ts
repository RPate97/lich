import type { RuntimeContext } from "../../sandbox/runtime.js";
import type { ExecResult, ExecOptions } from "../../sandbox/backend.js";
import type { StackExecutor } from "../executor.js";
import type { RunUpInput, RunUpResult } from "../../commands/up.js";
import type { RunDownInput, RunDownResult } from "../../commands/down.js";
import type { RunExecInput, RunExecResult } from "../../commands/exec.js";
import type { RunLogsInput, RunLogsResult } from "../../commands/logs.js";

interface RuntimeLike {
  down(ctx: RuntimeContext, opts?: { purge?: boolean }): Promise<void>;
  exec(ctx: RuntimeContext, args: ReadonlyArray<string>, opts?: ExecOptions): Promise<ExecResult>;
}

export class SandboxStackExecutor implements StackExecutor {
  constructor(private readonly runtime: RuntimeLike, private readonly ctx: RuntimeContext) {}

  async up(_input: RunUpInput): Promise<RunUpResult> {
    throw new Error("SandboxStackExecutor.up: not yet wired (see Phase E task)");
  }

  async down(input: RunDownInput): Promise<RunDownResult> {
    const purge = input.purge === true;
    await this.runtime.down(this.ctx, { purge });
    return { exitCode: 0, warnings: [] };
  }

  async exec(input: RunExecInput): Promise<RunExecResult> {
    const userArgv = input.argv ?? [];
    const result = await this.runtime.exec(this.ctx, ["lich", "exec", "--", ...userArgv], { inheritStdio: true });
    return { exitCode: result.exitCode };
  }

  logs(input: RunLogsInput): RunLogsResult {
    const follow = input.follow === true;
    const args: string[] = ["lich", "logs", ...(input.sources ?? [])];
    args.push(follow ? "--follow" : "--no-follow");
    if (!follow) args.push("--tail", String(input.count));
    const done = this.runtime.exec(this.ctx, args, {
      inheritStdio: true,
      timeoutMs: follow ? undefined : 30_000,
    }).then(() => undefined);
    return { exitCode: 0, done };
  }
}
