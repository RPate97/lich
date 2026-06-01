import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import type { SandboxBackend, ExecResult, ExecOptions, SandboxConfig } from './backend.js';
import type { SandboxRuntime as SandboxConfigBlock } from '../config/types.js';
import { TartBackend } from './tart.js';
import { SnapshotStore } from './snapshot-store.js';
import { goldenName, runName } from './naming.js';
import { computeBakeInputsHash } from './inputs-hash.js';
import { DEFAULT_IGNORE, type SandboxSync } from './sync.js';
import { MutagenSync, RealMutagenCli, RealSshTransport } from './mutagen.js';
import type { StackView } from '../daemon/dashboard/stacks-view.js';

export interface RuntimeContext {
  worktreeId: string;
  worktreePath: string;
  lichYamlPath: string;
  profileName: string;
}

export interface UpOutcome {
  path: 'cold' | 'warm';
  vmName: string;
  vmIp: string;
  durationMs: number;
}

const DEFAULT_LICH_HOME = process.env.LICH_HOME ?? join(homedir(), '.lich');

// Disk-fork model (Apple Virtualization.framework cannot suspend Linux guests,
// so memory-snapshot fork is unavailable). A golden is a *stopped* VM whose
// disk holds the baked stack (migrations, installed deps, build output). A fork
// is a CoW disk clone of that golden, booted fresh. Creating a golden requires
// stopping the stack to flush the disk, so it is an explicit step (snapshot()),
// not a silent side effect of up().
export class SandboxRuntime {
  private readonly backend: SandboxBackend;
  private readonly store: SnapshotStore;
  private readonly config: SandboxConfigBlock;
  private readonly bootWaitMs: number;
  private readonly sync: SandboxSync;

  constructor(
    config: SandboxConfigBlock,
    opts: {
      backend?: SandboxBackend;
      snapshotStore?: SnapshotStore;
      /** Wait after VM start before exec, letting the guest agent come up. Injectable for tests. */
      bootWaitMs?: number;
      sync?: SandboxSync;
    } = {},
  ) {
    this.config = config;
    this.backend = opts.backend ?? new TartBackend();
    const storeDir = opts.snapshotStore ? '' : (config.snapshot_store ?? join(DEFAULT_LICH_HOME, 'sandboxes'));
    this.store = opts.snapshotStore ?? new SnapshotStore(storeDir);
    this.bootWaitMs = opts.bootWaitMs ?? 5000;
    this.sync = opts.sync ?? new MutagenSync(new RealMutagenCli(), new RealSshTransport());
  }

  private resolvedIgnore(): string[] {
    return [...new Set([...DEFAULT_IGNORE, ...(this.config.sync?.ignore ?? [])])];
  }

  async up(ctx: RuntimeContext): Promise<UpOutcome> {
    const start = Date.now();
    const inputsHash = await computeBakeInputsHash({
      worktreePath: ctx.worktreePath,
      lichYamlPath: ctx.lichYamlPath,
      profileName: ctx.profileName,
      bakeInputs: this.config.bake_inputs,
    });
    const runVm = runName(ctx.worktreeId, ctx.profileName);

    const runState = await this.backend.inspect(runVm);
    if (runState.state !== 'absent') {
      // Existing run VM (running or stopped). Re-bringUp regardless of state
      // to heal any drift since the last up — services may have crashed,
      // source may have changed, prior bringUp may have aborted partway.
      // In-VM `lich up` is itself idempotent on an already-up stack.
      if (runState.state === 'stopped') {
        await this.backend.start(runVm);
        await new Promise(r => setTimeout(r, this.bootWaitMs));
      }
      // Re-up: disk already baked, regardless of cold vs fork origin.
      const vmIp = await this.bringUp(ctx, runVm, { skipBaked: true });
      return { path: 'warm', vmName: runVm, vmIp, durationMs: Date.now() - start };
    }

    const golden = this.store.findByHash(inputsHash);
    const warmForkEnabled = this.config.warm_fork ?? true;

    if (golden && warmForkEnabled) {
      const goldenState = await this.backend.inspect(golden.vmName);
      if (goldenState.state === 'stopped') {
        // Fork: CoW-clone the golden's baked disk and boot it.
        await this.backend.clone(golden.vmName, runVm);
        await this.backend.start(runVm);
        const vmIp = await this.bringUp(ctx, runVm, { skipBaked: true });
        this.store.recordFork({
          runVm,
          goldenHash: inputsHash,
          createdAt: new Date().toISOString(),
        });
        return { path: 'warm', vmName: runVm, vmIp, durationMs: Date.now() - start };
      }
      // Golden VM gone (deleted out of band). Drop the stale manifest entry.
      this.store.remove(inputsHash);
    }

    const vmIp = await this.coldBoot(ctx, runVm);
    return { path: 'cold', vmName: runVm, vmIp, durationMs: Date.now() - start };
  }

  // Create a golden snapshot from the current run VM. Stops the stack to flush
  // its disk, CoW-clones it to the golden, and restarts the run VM. Explicit
  // because it disrupts the running stack. `keepStopped` skips the trailing
  // restart — bake-on-down passes true to avoid a wasted stop+start cycle.
  async snapshot(ctx: RuntimeContext, opts: { keepStopped?: boolean } = {}): Promise<string> {
    const inputsHash = await computeBakeInputsHash({
      worktreePath: ctx.worktreePath,
      lichYamlPath: ctx.lichYamlPath,
      profileName: ctx.profileName,
      bakeInputs: this.config.bake_inputs,
    });
    const runVm = runName(ctx.worktreeId, ctx.profileName);
    const goldenVm = goldenName(inputsHash);

    // First-writer-wins: reuse an existing golden VM for this hash; stale manifest falls through.
    const existing = this.store.findByHash(inputsHash);
    if (existing) {
      const existingState = await this.backend.inspect(existing.vmName);
      if (existingState.state !== 'absent') return existing.vmName;
    }

    const runState = await this.backend.inspect(runVm);
    if (runState.state === 'absent') {
      throw new Error(`no sandbox VM to snapshot. Run 'lich up ${ctx.profileName}' first.`);
    }

    await this.backend.stop(runVm);
    await this.backend.destroy(goldenVm);
    await this.backend.clone(runVm, goldenVm);
    if (!opts.keepStopped) {
      await this.backend.start(runVm);
    }

    this.store.upsert({
      inputsHash,
      vmName: goldenVm,
      profileName: ctx.profileName,
      lichYamlSnapshot: readFileSync(ctx.lichYamlPath, 'utf8'),
      createdAt: new Date().toISOString(),
    });
    return goldenVm;
  }

  private async coldBoot(ctx: RuntimeContext, runVm: string): Promise<string> {
    const sandboxConfig: SandboxConfig = {
      name: runVm,
      image: this.config.image ?? 'lich-sandbox-base',
      memoryMb: this.config.memory ?? 4096,
      cpus: this.config.cpus ?? 4,
    };
    await this.backend.create(sandboxConfig);
    await this.backend.start(runVm);
    await new Promise(r => setTimeout(r, this.bootWaitMs));
    return this.bringUp(ctx, runVm, { skipBaked: false });
  }

  // The guest network lags VM "running"; tart ip fails until DHCP completes.
  private async ipWithRetry(runVm: string, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const ip = (await this.backend.ip(runVm)).trim();
        if (ip) return ip;
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`sandbox VM '${runVm}' got no IP within ${timeoutMs}ms${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''}`);
  }

  private async bringUp(ctx: RuntimeContext, runVm: string, opts: { skipBaked: boolean }): Promise<string> {
    const target = await this.ipWithRetry(runVm);
    await this.sync.start({
      name: runVm,
      hostPath: ctx.worktreePath,
      target,
      guestPath: '/workspace',
      ignore: this.resolvedIgnore(),
      extraFlags: this.config.sync?.mutagen_flags,
    });
    const env: Record<string, string> = { LICH_SANDBOX_GUEST: '1', LICH_NO_BROWSER: '1', LICH_DAEMON_HOST: '0.0.0.0' };
    if (opts.skipBaked) env.LICH_SKIP_BAKED = '1';
    const result = await this.backend.exec(runVm,
      ['lich', 'up', ctx.profileName],
      { cwd: '/workspace', timeoutMs: 600_000, inheritStdio: true, env });
    if (result.exitCode !== 0) {
      throw new Error(`in-VM 'lich up ${ctx.profileName}' failed with exit ${result.exitCode}`);
    }
    return target;
  }

  async down(ctx: RuntimeContext, opts: { purge?: boolean; bakeBeforeStop?: boolean } = {}): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const runVm = runName(ctx.worktreeId, ctx.profileName);
    const state = await this.backend.inspect(runVm);
    if (state.state === 'absent') return { warnings };
    if (state.state === 'running') {
      await this.backend.exec(runVm,
        ['lich', 'down'],
        { cwd: '/workspace', timeoutMs: 120_000, inheritStdio: true });
    }
    await this.sync.terminate(runVm);
    if (opts.bakeBeforeStop) {
      try {
        await this.snapshot(ctx, { keepStopped: true });
      } catch (e) {
        warnings.push(`bake-on-down failed: ${e instanceof Error ? e.message : String(e)} (run \`lich sandbox snapshot\` to retry)`);
      }
    }
    if (opts.purge) {
      await this.backend.destroy(runVm);
    } else {
      await this.backend.stop(runVm);
    }
    return { warnings };
  }

  async exec(ctx: RuntimeContext, args: ReadonlyArray<string>, opts?: ExecOptions): Promise<ExecResult> {
    const runVm = runName(ctx.worktreeId, ctx.profileName);
    const state = await this.backend.inspect(runVm);
    if (state.state === 'absent') {
      throw new Error(`no sandbox VM for this worktree+profile. Run 'lich up ${ctx.profileName}' first.`);
    }
    if (state.state !== 'running') {
      throw new Error(`sandbox VM '${runVm}' is ${state.state}, not running`);
    }
    return this.backend.exec(runVm, args, { cwd: '/workspace', ...opts });
  }

  async scrapeInVmStack(ctx: RuntimeContext, runVm: string): Promise<StackView | null> {
    const result = await this.backend.exec(runVm, ['lich', 'stacks', '--json'], { cwd: '/workspace', timeoutMs: 10_000 });
    if (result.exitCode !== 0) return null;
    try {
      const all = JSON.parse(result.stdout) as StackView[];
      return all.find((s) => s.active_profile === ctx.profileName) ?? all[0] ?? null;
    } catch {
      return null;
    }
  }
}
