import { describe, test, expect } from 'vitest';
import { goldenName, runName, isLichManagedName } from '../../../src/sandbox/naming.js';

describe('sandbox naming', () => {
  test('goldenName is deterministic from hash', () => {
    expect(goldenName('abc123def456ghi789')).toBe('lich-golden-abc123def456');
  });

  test('runName slugifies profile name', () => {
    expect(runName('worktree1', 'dev:heavy')).toBe('lich-run-worktree1-dev-heavy');
  });

  test('runName truncates long worktree IDs', () => {
    expect(runName('a'.repeat(50), 'dev')).toBe(`lich-run-${'a'.repeat(16)}-dev`);
  });

  test('isLichManagedName matches both patterns', () => {
    expect(isLichManagedName('lich-golden-abc')).toBe(true);
    expect(isLichManagedName('lich-run-wt-dev')).toBe(true);
    expect(isLichManagedName('my-vm')).toBe(false);
  });
});
