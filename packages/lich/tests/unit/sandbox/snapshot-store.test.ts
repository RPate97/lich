import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../../src/sandbox/snapshot-store.js';

describe('SnapshotStore', () => {
  let store: SnapshotStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lich-snap-'));
    store = new SnapshotStore(dir);
  });

  test('findByHash returns undefined for unknown hash', () => {
    expect(store.findByHash('abc')).toBeUndefined();
  });

  test('upsert + findByHash round-trip', () => {
    store.upsert({
      inputsHash: 'h1',
      vmName: 'lich-golden-h1',
      profileName: 'dev',
      lichYamlSnapshot: 'version: "1"',
      createdAt: '2026-05-30T00:00:00Z',
    });
    expect(store.findByHash('h1')).toMatchObject({ inputsHash: 'h1', vmName: 'lich-golden-h1' });
  });

  test('upsert replaces existing entry with same hash', () => {
    store.upsert({ inputsHash: 'h1', vmName: 'old', profileName: 'd', lichYamlSnapshot: '', createdAt: 'a' });
    store.upsert({ inputsHash: 'h1', vmName: 'new', profileName: 'd', lichYamlSnapshot: '', createdAt: 'b' });
    expect(store.list()).toHaveLength(1);
    expect(store.findByHash('h1')?.vmName).toBe('new');
  });

  test('remove returns true on success and false if missing', () => {
    store.upsert({ inputsHash: 'h1', vmName: 'v1', profileName: 'd', lichYamlSnapshot: '', createdAt: 'a' });
    expect(store.remove('h1')).toBe(true);
    expect(store.remove('h1')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test('list returns multiple entries', () => {
    store.upsert({ inputsHash: 'a', vmName: 'va', profileName: 'd', lichYamlSnapshot: '', createdAt: 't' });
    store.upsert({ inputsHash: 'b', vmName: 'vb', profileName: 'd', lichYamlSnapshot: '', createdAt: 't' });
    expect(store.list()).toHaveLength(2);
  });

  describe('forks', () => {
    test('forks.json absent returns empty array', () => {
      expect(new SnapshotStore(dir).forks()).toEqual([]);
    });

    test('recordFork persists across SnapshotStore instances', () => {
      const s1 = new SnapshotStore(dir);
      s1.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      const s2 = new SnapshotStore(dir);
      expect(s2.forks().map(f => f.runVm)).toEqual(['lich-run-A']);
    });

    test('recordFork upserts on runVm key (re-fork overwrites)', () => {
      const s = new SnapshotStore(dir);
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h2', createdAt: '2026-05-31T00:00:01Z' });
      expect(s.forks().length).toBe(1);
      expect(s.forks()[0]!.goldenHash).toBe('h2');
    });

    test('removeFork returns true on hit, false on miss', () => {
      const s = new SnapshotStore(dir);
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      expect(s.removeFork('lich-run-A')).toBe(true);
      expect(s.removeFork('lich-run-A')).toBe(false);
    });

    test('forksOf filters by golden hash', () => {
      const s = new SnapshotStore(dir);
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      s.recordFork({ runVm: 'lich-run-B', goldenHash: 'h2', createdAt: '2026-05-31T00:00:00Z' });
      s.recordFork({ runVm: 'lich-run-C', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      expect(s.forksOf('h1').map(f => f.runVm).sort()).toEqual(['lich-run-A', 'lich-run-C']);
    });

    test('clearForks empties the list', () => {
      const s = new SnapshotStore(dir);
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '2026-05-31T00:00:00Z' });
      s.clearForks();
      expect(s.forks()).toEqual([]);
    });

    test('forks file independent of manifest', () => {
      const s = new SnapshotStore(dir);
      s.upsert({ inputsHash: 'h1', vmName: 'golden-h1', profileName: 'dev', lichYamlSnapshot: '', createdAt: '...' });
      s.recordFork({ runVm: 'lich-run-A', goldenHash: 'h1', createdAt: '...' });
      s.clear();
      expect(s.forks().length).toBe(1);
      s.clearForks();
      expect(s.list()).toEqual([]);
    });
  });
});
