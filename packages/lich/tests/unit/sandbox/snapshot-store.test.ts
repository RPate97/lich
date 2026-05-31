import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../../src/sandbox/snapshot-store.js';

describe('SnapshotStore', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'lich-snap-')));
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
});
