import { describe, test, expect } from 'vitest';
import { selectGoldensToEvict } from '../../../src/sandbox/gc.js';
import type { GoldenManifest } from '../../../src/sandbox/snapshot-store.js';

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
