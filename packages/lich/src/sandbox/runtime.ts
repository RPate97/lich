import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import type { SandboxBackend, ExecResult, ExecOptions, SandboxConfig } from './backend.js';
import type { SandboxRuntime as SandboxConfigBlock } from '../config/types.js';
import { TartBackend } from './tart.js';
import { SnapshotStore } from './snapshot-store.js';
import { goldenName, runName } from './naming.js';
import { computeInputsHash } from './inputs-hash.js';

export interface RuntimeContext {
  worktreeId: string;
  worktreePath: string;
  lichYamlPath: string;
  profileName: string;
}

export interface UpOutcome {
  path: 'cold' | 'warm';
  vmName: string;
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

  constructor(
    config: SandboxConfigBlock,
    opts: {
      backend?: SandboxBackend;
      snapshotStore?: SnapshotStore;
      /** Wait after VM start before exec, letting the guest agent come up. Injectable for tests. */
      bootWaitMs?: number;
    } = {},
  ) {
    this.config = config;
    this.backend = opts.backend ?? new TartBackend();
    const storeDir = opts.snapshotStore ? '' : (config.snapshot_store ?? join(DEFAULT_LICH_HOME, 'sandboxes'));
    this.store = opts.snapshotStore ?? new SnapshotStore(storeDir);
    this.bootWaitMs = opts.bootWaitMs ?? 5000;
  }

  async up(ctx: RuntimeContext): Promise<UpOutcome> {
    const start = Date.now();
    const inputsHash = computeInputsHash(ctx.lichYamlPath, ctx.profileName);
    const runVm = runName(ctx.worktreeId, ctx.profileName);

    const runState = await this.backend.inspect(runVm);
    if (runState.state === 'running') {
      return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
    }
    if (runState.state === 'stopped') {
      await this.backend.start(runVm);
      return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
    }

    const golden = this.store.findByHash(inputsHash);
    const warmForkEnabled = this.config.warm_fork ?? true;

    if (golden && warmForkEnabled) {
      const goldenState = await this.backend.inspect(golden.vmName);
      if (goldenState.state === 'stopped') {
        // Fork: CoW-clone the golden's baked disk and boot it.
        await this.backend.clone(golden.vmName, runVm);
        await this.backend.start(runVm);
        await this.bringUp(ctx, runVm);
        return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
      }
      // Golden VM gone (deleted out of band). Drop the stale manifest entry.
      this.store.remove(inputsHash);
    }

    await this.coldBoot(ctx, runVm);
    return { path: 'cold', vmName: runVm, durationMs: Date.now() - start };
  }

  // Create a golden snapshot from the current run VM. Stops the stack to flush
  // its disk, CoW-clones it to the golden, and restarts the run VM. Explicit
  // because it disrupts the running stack.
  async snapshot(ctx: RuntimeContext): Promise<string> {
    const inputsHash = computeInputsHash(ctx.lichYamlPath, ctx.profileName);
    const runVm = runName(ctx.worktreeId, ctx.profileName);
    const goldenVm = goldenName(inputsHash);

    const runState = await this.backend.inspect(runVm);
    if (runState.state === 'absent') {
      throw new Error(`no sandbox VM to snapshot. Run 'lich up ${ctx.profileName}' first.`);
    }

    await this.backend.stop(runVm);
    await this.backend.destroy(goldenVm);
    await this.backend.clone(runVm, goldenVm);
    await this.backend.start(runVm);

    this.store.upsert({
      inputsHash,
      vmName: goldenVm,
      profileName: ctx.profileName,
      lichYamlSnapshot: readFileSync(ctx.lichYamlPath, 'utf8'),
      createdAt: new Date().toISOString(),
    });
    return goldenVm;
  }

  private async coldBoot(ctx: RuntimeContext, runVm: string): Promise<void> {
    const sandboxConfig: SandboxConfig = {
      name: runVm,
      image: this.config.image ?? 'lich-sandbox-base',
      memoryMb: this.config.memory ?? 4096,
      cpus: this.config.cpus ?? 4,
      mounts: [{ hostPath: ctx.worktreePath, guestPath: '/workspace', readOnly: false }],
    };
    await this.backend.create(sandboxConfig);
    await this.backend.start(runVm);
    await new Promise(r => setTimeout(r, this.bootWaitMs));
    await this.bringUp(ctx, runVm);
  }

  private async bringUp(ctx: RuntimeContext, runVm: string): Promise<void> {
    const result = await this.backend.exec(runVm,
      ['lich', 'up', ctx.profileName],
      { cwd: '/workspace', timeoutMs: 600_000, inheritStdio: true });
    if (result.exitCode !== 0) {
      throw new Error(`in-VM 'lich up ${ctx.profileName}' failed with exit ${result.exitCode}`);
    }
  }

  async down(ctx: RuntimeContext, opts: { purge?: boolean } = {}): Promise<void> {
    const runVm = runName(ctx.worktreeId, ctx.profileName);
    const state = await this.backend.inspect(runVm);
    if (state.state === 'absent') return;
    if (state.state === 'running') {
      await this.backend.exec(runVm,
        ['lich', 'down'],
        { cwd: '/workspace', timeoutMs: 120_000, inheritStdio: true });
    }
    if (opts.purge) {
      await this.backend.destroy(runVm);
    } else {
      await this.backend.stop(runVm);
    }
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
}
