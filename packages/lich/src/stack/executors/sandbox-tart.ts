import type { RuntimeContext, UpOutcome } from "../../sandbox/runtime.js";
import type { ExecResult, ExecOptions } from "../../sandbox/backend.js";
import type { StackExecutor } from "../executor.js";
import type { RunUpInput, RunUpResult } from "../../commands/up.js";
import type { RunDownInput, RunDownResult } from "../../commands/down.js";
import type { RunExecInput, RunExecResult } from "../../commands/exec.js";
import type { RunLogsInput, RunLogsResult } from "../../commands/logs.js";
import type { Worktree } from "../../worktree/detect.js";
import type { StackView } from "../../daemon/dashboard/stacks-view.js";
import { writeSnapshot } from "../../state/snapshot.js";
import { parseConfig } from "../../config/parse.js";
import { ensureDaemonRunning } from "../../daemon/auto-start.js";

interface RuntimeLike {
  up(ctx: RuntimeContext): Promise<UpOutcome>;
  down(ctx: RuntimeContext, opts?: { purge?: boolean; bakeBeforeStop?: boolean }): Promise<{ warnings: string[] }>;
  exec(ctx: RuntimeContext, args: ReadonlyArray<string>, opts?: ExecOptions): Promise<ExecResult>;
  scrapeInVmStack(ctx: RuntimeContext, runVm: string): Promise<StackView | null>;
  scrapeInVmDaemonPort?(runVm: string): Promise<number | null>;
}

export class SandboxStackExecutor implements StackExecutor {
  constructor(
    private readonly runtime: RuntimeLike,
    private readonly ctx: RuntimeContext,
    private readonly deps: { worktree: Worktree; warmForkEnabled?: boolean },
  ) {}

  private async resolveWarmForkEnabled(): Promise<boolean> {
    if (this.deps.warmForkEnabled !== undefined) return this.deps.warmForkEnabled;
    try {
      const parsed = await parseConfig(this.ctx.lichYamlPath);
      if (!parsed.ok) return true;
      return parsed.config.runtime?.sandbox?.warm_fork ?? true;
    } catch {
      return true;
    }
  }

  async up(input: RunUpInput): Promise<RunUpResult> {
    const outcome = await this.runtime.up(this.ctx);
    const verb = outcome.path === "warm" ? "warm-forked" : "cold-booted";
    const out = input.out ?? process.stdout;
    out.write(`sandbox VM '${outcome.vmName}' ${verb} in ${outcome.durationMs}ms\n`);
    const scraped = await this.runtime.scrapeInVmStack(this.ctx, outcome.vmName);
    // In-VM daemon picks a free port at startup (not 3300). The host needs
    // the actual port to construct a working data_source.base_url; 3300 is
    // the legacy fallback if the scrape can't find it.
    const apiPort = (await this.runtime.scrapeInVmDaemonPort?.(outcome.vmName)) ?? 3300;
    const services = (scraped?.services ?? []).map((s) => ({
      name: s.name,
      kind: (s.kind ?? "owned") as "owned" | "compose",
      state: s.state as import("../../state/snapshot.js").ServiceState,
      allocated_ports: s.ports ?? {},
    }));
    const routing = (scraped?.services ?? [])
      .filter((s) => s.ports && Object.keys(s.ports).length > 0)
      .map((s) => {
        const port = Object.values(s.ports!)[0]!;
        return {
          hostname: `${s.name}.${this.deps.worktree.name}`,
          upstream_url: `http://${outcome.vmIp}:${port}`,
          service: s.name,
        };
      });
    await writeSnapshot({
      stack_id: this.deps.worktree.stack_id,
      worktree_name: this.deps.worktree.name,
      worktree_path: this.deps.worktree.path,
      status: "up",
      started_at: new Date().toISOString(),
      services,
      routing,
      active_profile: this.ctx.profileName,
      executor: { kind: "sandbox-tart", vm_name: outcome.vmName },
      data_source: scraped
        ? { kind: "http", base_url: `http://${outcome.vmIp}:${apiPort}`, stack_id: scraped.id }
        : { kind: "local" },
    });
    await this.ensureHostDaemon(input, out);
    return { exitCode: 0, stackId: this.deps.worktree.stack_id };
  }

  // The host daemon proxies the dashboard for both local AND sandbox stacks;
  // failures here never fail the up — the stack is ready either way.
  private async ensureHostDaemon(input: RunUpInput, out: NodeJS.WritableStream): Promise<void> {
    const envNoBrowser =
      process.env.LICH_NO_BROWSER === "1" ||
      process.env.LICH_NO_BROWSER === "true";
    const noBrowser = (input.noBrowser ?? false) || envNoBrowser;
    const lichHomeEnv = process.env.LICH_HOME;
    const ensureOpts: Parameters<typeof ensureDaemonRunning>[0] = {
      openBrowser: !noBrowser,
    };
    if (lichHomeEnv !== undefined) ensureOpts.lichHome = lichHomeEnv;
    try {
      const parsed = await parseConfig(this.ctx.lichYamlPath);
      const proxyPort = parsed.ok ? parsed.config.runtime?.proxy_port : undefined;
      if (typeof proxyPort === "number") ensureOpts.proxyPort = proxyPort;
    } catch { /* fall back to defaults */ }
    try {
      await ensureDaemonRunning(ensureOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.write(`warning: dashboard daemon failed to start: ${msg}\n`);
    }
  }

  async down(input: RunDownInput): Promise<RunDownResult> {
    const purge = input.purge === true;
    const warmForkEnabled = await this.resolveWarmForkEnabled();
    const result = await this.runtime.down(this.ctx, { purge, bakeBeforeStop: warmForkEnabled });
    const out = input.out ?? process.stdout;
    const warnings = result.warnings.map((message) => ({ phase: "bake_on_down", message }));
    for (const w of warnings) {
      out.write(`warning: ${w.message}\n`);
    }
    return { exitCode: 0, warnings };
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
    if (!follow && input.count > 0) args.push("--tail", String(input.count));
    const done = this.runtime.exec(this.ctx, args, {
      inheritStdio: true,
      timeoutMs: follow ? undefined : 30_000,
    }).then(() => undefined);
    return { exitCode: 0, done };
  }
}
