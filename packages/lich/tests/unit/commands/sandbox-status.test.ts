import { describe, test, expect } from 'vitest';
import {
  formatAge,
  formatBytes,
  buildStatusJson,
} from '../../../src/commands/sandbox/status.js';
import type { GoldenManifest, Fork } from '../../../src/sandbox/snapshot-store.js';

describe('formatAge', () => {
  test('seconds under 60', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(45)).toBe('45s');
  });
  test('minutes under 60', () => {
    expect(formatAge(60)).toBe('1m');
    expect(formatAge(60 * 59)).toBe('59m');
  });
  test('hours under 24', () => {
    expect(formatAge(60 * 60)).toBe('1h 0m');
    expect(formatAge(2 * 3600 + 14 * 60)).toBe('2h 14m');
  });
  test('days', () => {
    expect(formatAge(24 * 3600)).toBe('1d 0h');
    expect(formatAge(5 * 24 * 3600 + 12 * 3600)).toBe('5d 12h');
  });
  test('negative/NaN clamped to 0s', () => {
    expect(formatAge(-100)).toBe('0s');
    expect(formatAge(Number.NaN)).toBe('0s');
  });
});

describe('formatBytes', () => {
  test('zero/negative', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
  test('MB and GB', () => {
    expect(formatBytes(450 * 1024 * 1024)).toBe('450 MB');
    expect(formatBytes(20 * 1024 * 1024 * 1024)).toBe('20.0 GB');
  });
});

function g(hash: string, profile: string, createdAt: string, sizeBytes = 1e9): GoldenManifest {
  return {
    inputsHash: hash,
    vmName: `lich-golden-${hash}`,
    profileName: profile,
    lichYamlSnapshot: '',
    createdAt,
    sizeBytes,
  };
}

describe('buildStatusJson', () => {
  test('decorates goldens with shortHash, ageSeconds, evictionCandidate', () => {
    const now = Date.parse('2026-05-31T00:00:00Z');
    const goldens = [
      g('aaaaaaaaaaaa1111', 'dev', '2026-05-30T22:00:00Z'),
      g('bbbbbbbbbbbb2222', 'dev', '2026-05-30T00:00:00Z'),
      g('cccccccccccc3333', 'dev', '2026-05-25T00:00:00Z'),
    ];
    const forks: Fork[] = [
      { runVm: 'lich-run-wt1-dev', goldenHash: 'aaaaaaaaaaaa1111', createdAt: '2026-05-30T23:00:00Z' },
    ];
    const status = buildStatusJson({
      goldens,
      forks,
      liveForkCounts: new Map([['aaaaaaaaaaaa1111', 1]]),
      liveGoldenHashes: new Set(['aaaaaaaaaaaa1111']),
      policy: { keepPerProfile: 2, maxTotalBytes: 20e9 },
      current: null,
      now,
    });
    expect(status.goldens).toHaveLength(3);
    const first = status.goldens[0]!;
    expect(first.shortHash).toBe('aaaaaaaaaaaa');
    expect(first.ageSeconds).toBe(2 * 3600);
    expect(first.liveForkCount).toBe(1);
    expect(first.evictionCandidate).toBe(false);
    const third = status.goldens[2]!;
    expect(third.evictionCandidate).toBe(true);
    expect(status.forks).toEqual([
      { runVm: 'lich-run-wt1-dev', goldenHash: 'aaaaaaaaaaaa1111', createdAt: '2026-05-30T23:00:00Z' },
    ]);
    expect(status.current).toBeNull();
    expect(status.policy.keepPerProfile).toBe(2);
  });

  test('current block passes through', () => {
    const status = buildStatusJson({
      goldens: [],
      forks: [],
      liveForkCounts: new Map(),
      liveGoldenHashes: new Set(),
      policy: { keepPerProfile: 2, maxTotalBytes: 20e9 },
      current: { bakeInputsHash: 'abc', wouldFork: true, matchedGoldenHash: 'abc' },
      now: Date.now(),
    });
    expect(status.current).toEqual({ bakeInputsHash: 'abc', wouldFork: true, matchedGoldenHash: 'abc' });
    expect(status.goldens).toEqual([]);
    expect(status.forks).toEqual([]);
  });
});
