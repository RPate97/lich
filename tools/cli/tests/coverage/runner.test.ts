import { describe, it, expect } from 'vitest';
import { filesBelowThreshold, type CoverageSummary } from '../../src/coverage/runner';

const summary: CoverageSummary = {
  total: {
    lines: { total: 100, covered: 85, pct: 85 },
    statements: { total: 100, covered: 85, pct: 85 },
    branches: { total: 100, covered: 70, pct: 70 },
    functions: { total: 100, covered: 90, pct: 90 },
  },
  files: [
    {
      path: '/p/a.ts',
      lines: { total: 10, covered: 10, pct: 100 },
      statements: { total: 10, covered: 10, pct: 100 },
      branches: { total: 0, covered: 0, pct: 100 },
      functions: { total: 1, covered: 1, pct: 100 },
    },
    {
      path: '/p/b.ts',
      lines: { total: 10, covered: 5, pct: 50 },
      statements: { total: 10, covered: 5, pct: 50 },
      branches: { total: 4, covered: 1, pct: 25 },
      functions: { total: 2, covered: 1, pct: 50 },
    },
  ],
};

describe('filesBelowThreshold', () => {
  it('returns files below 80% line coverage', () => {
    expect(filesBelowThreshold(summary, 80).map((f) => f.path)).toEqual(['/p/b.ts']);
  });

  it('returns empty when threshold is 0', () => {
    expect(filesBelowThreshold(summary, 0)).toEqual([]);
  });

  it('returns all files when threshold > 100', () => {
    expect(
      filesBelowThreshold(summary, 101)
        .map((f) => f.path)
        .sort(),
    ).toEqual(['/p/a.ts', '/p/b.ts']);
  });
});
