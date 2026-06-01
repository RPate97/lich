import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc, selectGoldensToEvict } from '../../../src/sandbox/gc.js';
import { SnapshotStore, type GoldenManifest } from '../../../src/sandbox/snapshot-store.js';
import type {
  SandboxBackend,
  SandboxConfig,
  SandboxState,
  ExecResult,
  ExecOptions,
} from '../../../src/sandbox/backend.js';

function g(hash: string, profile: string, day: number, sizeGb = 1): GoldenManifest {
  return {
    inputsHash: hash,
    vmName: `golden-${hash}`,
    profileName: profile,
    lichYamlSnapshot: '',
    createdAt: `2026-05-${String(day).padStart(2, '0')}T00:00:00Z`,
    sizeBytes: sizeGb * 1e9,
  };
}

const policy = { keepPerProfile: 2, maxTotalBytes: 20e9 };

describe('selectGoldensToEvict', () => {
  test('keeps the 2 most-recent per profile, evicts older', () => {
    const goldens = [g('a', 'dev', 1), g('b', 'dev', 2), g('c', 'dev', 3)];
    const evict = selectGoldensToEvict(goldens, new Set(), policy);
    expect(evict.map((e) => e.inputsHash)).toEqual(['a']);
  });

  test('never evicts a golden with live forks', () => {
    const goldens = [g('a', 'dev', 1), g('b', 'dev', 2), g('c', 'dev', 3)];
    const evict = selectGoldensToEvict(goldens, new Set(['a']), policy);
    expect(evict.map((e) => e.inputsHash)).not.toContain('a');
  });

  test('per-profile keep is independent across profiles', () => {
    const goldens = [g('a', 'dev', 1), g('b', 'dev', 2), g('c', 'dev', 3), g('x', 'web', 1)];
    const evict = selectGoldensToEvict(goldens, new Set(), policy);
    expect(evict.map((e) => e.inputsHash)).toEqual(['a']);
  });

  test('global LRU cap evicts oldest beyond size budget even within keep-N', () => {
    const goldens = [g('a', 'dev', 1, 15), g('b', 'dev', 2, 15)];
    const evict = selectGoldensToEvict(goldens, new Set(), policy);
    expect(evict.map((e) => e.inputsHash)).toEqual(['a']);
  });

  test('LRU cap still never evicts live goldens (keep-on-uncertainty)', () => {
    const goldens = [g('a', 'dev', 1, 15), g('b', 'dev', 2, 15)];
    const evict = selectGoldensToEvict(goldens, new Set(['a', 'b']), policy);
    expect(evict).toEqual([]);
  });
});

class FakeBackend implements SandboxBackend {
  destroyCalls: string[] = [];
  destroyFails = new Set<string>();
  states = new Map<string, SandboxState['state']>();

  async create(config: SandboxConfig): Promise<void> {
    this.states.set(config.name, 'stopped');
  }
  async start(name: string): Promise<void> {
    this.states.set(name, 'running');
  }
  async stop(name: string): Promise<void> {
    this.states.set(name, 'stopped');
  }
  async destroy(name: string): Promise<void> {
    this.destroyCalls.push(name);
    if (this.destroyFails.has(name)) throw new Error(`destroy failed for ${name}`);
    this.states.delete(name);
  }
  async clone(_src: string, dest: string): Promise<void> {
    this.states.set(dest, 'stopped');
  }
  async exec(_name: string, _cmd: readonly string[], _opts?: ExecOptions): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async ip(): Promise<string> {
    return '10.0.0.1';
  }
  async list(): Promise<readonly SandboxState[]> {
    return [...this.states.entries()].map(([name, state]) => ({ name, state }));
  }
  async inspect(name: string): Promise<SandboxState> {
    return { name, state: this.states.get(name) ?? 'absent' };
  }
}

describe('runGc', () => {
  let store: SnapshotStore;
  let backend: FakeBackend;

  beforeEach(() => {
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'lich-gc-store-')));
    backend = new FakeBackend();
  });

  function seedGolden(hash: string, profile: string, day: number, sizeGb = 1): void {
    store.upsert(g(hash, profile, day, sizeGb));
    backend.states.set(`golden-${hash}`, 'stopped');
  }

  test('evicts oldest golden per profile when keep-N exceeded', async () => {
    seedGolden('a', 'dev', 1);
    seedGolden('b', 'dev', 2);
    seedGolden('c', 'dev', 3);

    const { evicted } = await runGc(store, backend, policy);

    expect(evicted.map(e => e.inputsHash)).toEqual(['a']);
    expect(backend.destroyCalls).toContain('golden-a');
    expect(store.list().map(g => g.inputsHash).sort()).toEqual(['b', 'c']);
  });

  test('never evicts a golden whose fork run VM is still present', async () => {
    seedGolden('a', 'dev', 1);
    seedGolden('b', 'dev', 2);
    seedGolden('c', 'dev', 3);
    store.recordFork({ runVm: 'run-a', goldenHash: 'a', createdAt: '2026-05-30T00:00:00Z' });
    backend.states.set('run-a', 'running');

    const { evicted } = await runGc(store, backend, policy);

    expect(evicted.map(e => e.inputsHash)).not.toContain('a');
    expect(store.findByHash('a')).toBeDefined();
  });

  test('prunes stale fork records (runVm absent) in passing', async () => {
    seedGolden('a', 'dev', 1);
    store.recordFork({ runVm: 'ghost-vm', goldenHash: 'a', createdAt: '2026-05-30T00:00:00Z' });

    await runGc(store, backend, policy);

    expect(store.forks().find(f => f.runVm === 'ghost-vm')).toBeUndefined();
  });

  test('LRU cap evicts beyond keep-N', async () => {
    seedGolden('a', 'dev', 1, 15);
    seedGolden('b', 'dev', 2, 15);

    const { evicted } = await runGc(store, backend, policy);

    expect(evicted.map(e => e.inputsHash)).toEqual(['a']);
    expect(backend.destroyCalls).toContain('golden-a');
  });

  test('returns empty array when nothing to evict', async () => {
    seedGolden('a', 'dev', 1);
    store.recordFork({ runVm: 'run-a', goldenHash: 'a', createdAt: '2026-05-30T00:00:00Z' });
    backend.states.set('run-a', 'running');

    const { evicted, warnings } = await runGc(store, backend, policy);

    expect(evicted).toEqual([]);
    expect(warnings).toEqual([]);
    expect(backend.destroyCalls).toEqual([]);
  });

  test('destroy failure on one golden does not block others', async () => {
    seedGolden('a', 'dev', 1);
    seedGolden('b', 'dev', 2);
    seedGolden('c', 'dev', 3);
    seedGolden('d', 'web', 1);
    seedGolden('e', 'web', 2);
    seedGolden('f', 'web', 3);
    backend.destroyFails.add('golden-a');

    const { evicted, warnings } = await runGc(store, backend, policy);

    expect(evicted.map(e => e.inputsHash).sort()).toEqual(['a', 'd']);
    expect(backend.destroyCalls.sort()).toEqual(['golden-a', 'golden-d']);
    expect(store.findByHash('a')).toBeUndefined();
    expect(store.findByHash('d')).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].vmName).toBe('golden-a');
    expect(warnings[0].inputsHash).toBe('a');
  });
});
