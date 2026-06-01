import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeAllSandboxes } from '../../../src/sandbox/purge-all.js';
import { SnapshotStore } from '../../../src/sandbox/snapshot-store.js';
import type {
  SandboxBackend,
  SandboxConfig,
  SandboxState,
  ExecResult,
  ExecOptions,
} from '../../../src/sandbox/backend.js';

class FakeBackend implements SandboxBackend {
  states = new Map<string, SandboxState['state']>();
  destroyCalls: string[] = [];

  async create(c: SandboxConfig): Promise<void> { this.states.set(c.name, 'stopped'); }
  async start(n: string): Promise<void> { this.states.set(n, 'running'); }
  async stop(n: string): Promise<void> { this.states.set(n, 'stopped'); }
  async destroy(n: string): Promise<void> { this.destroyCalls.push(n); this.states.delete(n); }
  async clone(_s: string, d: string): Promise<void> { this.states.set(d, 'stopped'); }
  async exec(_n: string, _c: readonly string[], _o?: ExecOptions): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async ip(): Promise<string> { return '10.0.0.1'; }
  async list(): Promise<readonly SandboxState[]> {
    return [...this.states.entries()].map(([name, state]) => ({ name, state }));
  }
  async inspect(name: string): Promise<SandboxState> {
    return { name, state: this.states.get(name) ?? 'absent' };
  }
}

describe('purgeAllSandboxes', () => {
  let store: SnapshotStore;
  let backend: FakeBackend;

  beforeEach(() => {
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'lich-purge-store-')));
    backend = new FakeBackend();
  });

  test('clears forks.json alongside manifest', async () => {
    store.upsert({
      inputsHash: 'h1',
      vmName: 'lich-golden-h1',
      profileName: 'dev',
      lichYamlSnapshot: '',
      createdAt: '2026-05-30T00:00:00Z',
    });
    store.recordFork({
      runVm: 'lich-run-wt-dev',
      goldenHash: 'h1',
      createdAt: '2026-05-30T00:00:00Z',
    });

    await purgeAllSandboxes({ backend, store });

    expect(store.forks()).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test('storeOnly clears forks too', async () => {
    store.recordFork({
      runVm: 'lich-run-wt-dev',
      goldenHash: 'h1',
      createdAt: '2026-05-30T00:00:00Z',
    });

    await purgeAllSandboxes({ backend, store, storeOnly: true });

    expect(store.forks()).toEqual([]);
  });

  test('vmsOnly does NOT clear forks', async () => {
    store.recordFork({
      runVm: 'lich-run-wt-dev',
      goldenHash: 'h1',
      createdAt: '2026-05-30T00:00:00Z',
    });

    await purgeAllSandboxes({ backend, store, vmsOnly: true });

    expect(store.forks().length).toBe(1);
  });
});
