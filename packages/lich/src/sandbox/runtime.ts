import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import type { SandboxBackend, ExecResult, ExecOptions, SandboxConfig } from './backend.js';
import type { SandboxRuntime as SandboxConfigBlock } from '../config/types.js';
import { TartBackend } from './tart.js';
import { SnapshotStore, type GoldenManifest } from './snapshot-store.js';
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

export class SandboxRuntime {
  private readonly backend: SandboxBackend;
  private readonly store: SnapshotStore;
  private readonly config: SandboxConfigBlock;
  private readonly sshWaitMs: number;

  constructor(
    config: SandboxConfigBlock,
    opts: {
      backend?: SandboxBackend;
      snapshotStore?: SnapshotStore;
      /** Override SSH warm-up wait after VM start. Default 5000ms. Injectable for tests. */
      sshWaitMs?: number;
    } = {},
  ) {
    this.config = config;
    this.backend = opts.backend ?? new TartBackend();
    const storeDir = opts.snapshotStore ? '' : (config.snapshot_store ?? join(DEFAULT_LICH_HOME, 'sandboxes'));
    this.store = opts.snapshotStore ?? new SnapshotStore(storeDir);
    this.sshWaitMs = opts.sshWaitMs ?? 5000;
  }

  async up(ctx: RuntimeContext): Promise<UpOutcome> {
    const start = Date.now();
    const inputsHash = computeInputsHash(ctx.lichYamlPath, ctx.profileName);
    const runVm = runName(ctx.worktreeId, ctx.profileName);

    const runState = await this.backend.inspect(runVm);
    if (runState.state === 'running') {
      return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
    }
    if (runState.state === 'suspended') {
      await this.backend.resume(runVm);
      return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
    }
    if (runState.state === 'stopped') {
      await this.backend.destroy(runVm);
    }

    const golden = this.store.findByHash(inputsHash);
    const warmForkEnabled = this.config.warm_fork ?? true;

    if (golden && warmForkEnabled) {
      const goldenState = await this.backend.inspect(golden.vmName);
      if (goldenState.state === 'suspended') {
        await this.backend.clone(golden.vmName, runVm);
        await this.backend.resume(runVm);
        return { path: 'warm', vmName: runVm, durationMs: Date.now() - start };
      }
      // Golden VM gone — drop stale manifest entry and fall through to cold-boot.
      this.store.remove(inputsHash);
    }

    await this.coldBoot(ctx, runVm);

    if (warmForkEnabled) {
      const goldenVm = goldenName(inputsHash);
      await this.backend.destroy(goldenVm);
      await this.backend.suspend(runVm);
      await this.backend.clone(runVm, goldenVm);
      await this.backend.resume(runVm);
      this.store.upsert({
        inputsHash,
        vmName: goldenVm,
        profileName: ctx.profileName,
        lichYamlSnapshot: readFileSync(ctx.lichYamlPath, 'utf8'),
        createdAt: new Date().toISOString(),
      });
    }

    return { path: 'cold', vmName: runVm, durationMs: Date.now() - start };
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
    await new Promise(r => setTimeout(r, this.sshWaitMs));
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
