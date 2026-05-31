import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxBackend, SandboxConfig, SandboxState, ExecResult, ExecOptions } from '../../../src/sandbox/backend.js';
import { SandboxRuntime } from '../../../src/sandbox/runtime.js';
import { SnapshotStore } from '../../../src/sandbox/snapshot-store.js';

class FakeBackend implements SandboxBackend {
  public states = new Map<string, SandboxState>();
  public ops: string[] = [];
  public execLog: Array<{ name: string; cmd: ReadonlyArray<string> }> = [];

  async create(c: SandboxConfig) { this.ops.push(`create ${c.name}`); this.states.set(c.name, { name: c.name, state: 'stopped' }); }
  async start(n: string) { this.ops.push(`start ${n}`); this.states.set(n, { name: n, state: 'running' }); }
  async stop(n: string) { this.ops.push(`stop ${n}`); this.states.set(n, { name: n, state: 'stopped' }); }
  async destroy(n: string) { this.ops.push(`destroy ${n}`); this.states.delete(n); }
  async suspend(n: string) { this.ops.push(`suspend ${n}`); this.states.set(n, { name: n, state: 'suspended' }); }
  async resume(n: string) { this.ops.push(`resume ${n}`); this.states.set(n, { name: n, state: 'running' }); }
  async clone(s: string, d: string) { this.ops.push(`clone ${s} ${d}`); this.states.set(d, { name: d, state: 'suspended' }); }
  async exec(n: string, cmd: ReadonlyArray<string>, _opts?: ExecOptions): Promise<ExecResult> {
    this.execLog.push({ name: n, cmd });
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async ip(_n: string) { return '10.0.0.1'; }
  async list() { return Array.from(this.states.values()); }
  async inspect(n: string) { return this.states.get(n) ?? { name: n, state: 'absent' as const }; }
}

function makeCtx(tmp: string, profile: string) {
  const lichYaml = join(tmp, 'lich.yaml');
  writeFileSync(lichYaml, `version: "1"\nprofile: ${profile}\n`);
  return {
    worktreeId: 'wt1',
    worktreePath: tmp,
    lichYamlPath: lichYaml,
    profileName: profile,
  };
}

describe('SandboxRuntime.up', () => {
  let tmp: string;
  let backend: FakeBackend;
  let store: SnapshotStore;
  let runtime: SandboxRuntime;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lich-runtime-'));
    backend = new FakeBackend();
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'lich-snap-')));
    runtime = new SandboxRuntime(
      { backend: 'tart', warm_fork: true },
      { backend, snapshotStore: store, sshWaitMs: 0 },
    );
  });

  test('cold-boot path: creates VM, runs lich up, snapshots as golden', async () => {
    const ctx = makeCtx(tmp, 'dev');
    const outcome = await runtime.up(ctx);
    expect(outcome.path).toBe('cold');
    expect(backend.ops).toContain('create lich-run-wt1-dev');
    expect(backend.ops).toContain('start lich-run-wt1-dev');
    expect(backend.execLog).toContainEqual({ name: 'lich-run-wt1-dev', cmd: ['lich', 'up', 'dev'] });
    expect(backend.ops).toContain('suspend lich-run-wt1-dev');
    expect(backend.ops.some(op => op.startsWith('clone lich-run-wt1-dev lich-golden-'))).toBe(true);
    expect(backend.ops).toContain('resume lich-run-wt1-dev');
    expect(store.list()).toHaveLength(1);
  });

  test('warm-fork path: finds golden, clones it, resumes', async () => {
    const ctx = makeCtx(tmp, 'dev');
    // First up to create the golden.
    await runtime.up(ctx);
    backend.ops.length = 0;
    backend.execLog.length = 0;
    // Destroy the run VM (simulating end of session).
    await backend.destroy('lich-run-wt1-dev');
    backend.ops.length = 0;

    // Second up — should fork from golden.
    const outcome = await runtime.up(ctx);
    expect(outcome.path).toBe('warm');
    // Should NOT have re-run lich up inside the VM.
    expect(backend.execLog.some(e => e.cmd.join(' ').includes('lich up'))).toBe(false);
    expect(backend.ops.some(op => op.startsWith('clone lich-golden-'))).toBe(true);
    expect(backend.ops).toContain('resume lich-run-wt1-dev');
  });

  test('warm-fork disabled: always cold-boots', async () => {
    runtime = new SandboxRuntime(
      { backend: 'tart', warm_fork: false },
      { backend, snapshotStore: store, sshWaitMs: 0 },
    );
    const ctx = makeCtx(tmp, 'dev');
    await runtime.up(ctx);
    backend.ops.length = 0;
    backend.execLog.length = 0;
    await backend.destroy('lich-run-wt1-dev');
    backend.ops.length = 0;

    await runtime.up(ctx);
    expect(backend.execLog).toContainEqual({ name: 'lich-run-wt1-dev', cmd: ['lich', 'up', 'dev'] });
  });

  test('existing running VM: idempotent', async () => {
    const ctx = makeCtx(tmp, 'dev');
    await runtime.up(ctx);
    backend.ops.length = 0;
    const outcome = await runtime.up(ctx);
    expect(outcome.path).toBe('warm');
    expect(backend.ops).toEqual([]);
  });

  test('suspended run VM: resumes', async () => {
    const ctx = makeCtx(tmp, 'dev');
    await runtime.up(ctx);
    await backend.suspend('lich-run-wt1-dev');
    backend.ops.length = 0;
    const outcome = await runtime.up(ctx);
    expect(outcome.path).toBe('warm');
    expect(backend.ops).toContain('resume lich-run-wt1-dev');
  });

  test('changing profile creates a different run VM and golden', async () => {
    await runtime.up(makeCtx(tmp, 'dev'));
    const ctx2 = makeCtx(tmp, 'dev:heavy');
    await runtime.up(ctx2);
    expect(store.list()).toHaveLength(2);
  });
});

describe('SandboxRuntime.down', () => {
  let tmp: string;
  let backend: FakeBackend;
  let runtime: SandboxRuntime;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lich-runtime-'));
    backend = new FakeBackend();
    runtime = new SandboxRuntime(
      { backend: 'tart', warm_fork: true },
      { backend, snapshotStore: new SnapshotStore(mkdtempSync(join(tmpdir(), 'lich-snap-'))), sshWaitMs: 0 },
    );
  });

  test('down stops the run VM (default, not purge)', async () => {
    const ctx = makeCtx(tmp, 'dev');
    await runtime.up(ctx);
    backend.ops.length = 0;
    await runtime.down(ctx);
    expect(backend.ops).toContain('stop lich-run-wt1-dev');
    expect(backend.ops).not.toContain('destroy lich-run-wt1-dev');
  });

  test('down --purge destroys the VM', async () => {
    const ctx = makeCtx(tmp, 'dev');
    await runtime.up(ctx);
    backend.ops.length = 0;
    await runtime.down(ctx, { purge: true });
    expect(backend.ops).toContain('destroy lich-run-wt1-dev');
  });

  test('down on absent VM is a no-op', async () => {
    const ctx = makeCtx(tmp, 'dev');
    await runtime.down(ctx);
    expect(backend.ops).toEqual([]);
  });
});
