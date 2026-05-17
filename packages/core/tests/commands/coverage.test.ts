import { describe, it, expect } from 'vitest';
import { makeCoverageCommand } from '../../src/commands/coverage';
import { CLIError } from '../../src/errors';
import type { CoverageSummary, RunCoverageOptions } from '../../src/coverage/runner';

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

function fakeRunner(out: CoverageSummary) {
  const calls: RunCoverageOptions[] = [];
  const fn = async (opts: RunCoverageOptions): Promise<CoverageSummary> => {
    calls.push(opts);
    return out;
  };
  return { fn, calls };
}

describe('levelzero coverage', () => {
  it('exposes name "coverage"', () => {
    const cmd = makeCoverageCommand(async () => summary);
    expect(cmd.name).toBe('coverage');
  });

  it('returns the full coverage summary when no threshold given', async () => {
    const { fn, calls } = fakeRunner(summary);
    const cmd = makeCoverageCommand(fn);
    const result = (await cmd.run({
      cwd: '/p',
      format: 'json',
      args: [],
      flags: {},
    })) as CoverageSummary;
    expect(result.total.lines.pct).toBe(85);
    expect(result.files.map((f) => f.path).sort()).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.projectRoot).toBe('/p');
  });

  it('returns the summary when --threshold is satisfied (no files below)', async () => {
    const cmd = makeCoverageCommand(async () => summary);
    const result = (await cmd.run({
      cwd: '/p',
      format: 'json',
      args: [],
      flags: { threshold: '40' },
    })) as CoverageSummary;
    expect(result.total).toBeDefined();
    expect(result.files).toHaveLength(2);
  });

  it('throws a CLIError with the offending files when --threshold is violated', async () => {
    const cmd = makeCoverageCommand(async () => summary);
    let thrown: unknown;
    try {
      await cmd.run({
        cwd: '/p',
        format: 'json',
        args: [],
        flags: { threshold: '80' },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    const err = thrown as CLIError;
    expect(err.code).toBe('COVERAGE_THRESHOLD');
    const payload = err.toJSON() as { details?: { threshold: number; files: Array<{ path: string; pct: number }> } };
    expect(payload.details?.threshold).toBe(80);
    expect(payload.details?.files.map((f) => f.path)).toEqual(['/p/b.ts']);
    expect(payload.details?.files[0]?.pct).toBe(50);
  });

  it('parses --threshold as a number even when passed as a string flag', async () => {
    const cmd = makeCoverageCommand(async () => summary);
    // 51 means /p/b.ts (50%) is below; /p/a.ts (100%) is fine.
    await expect(
      cmd.run({
        cwd: '/p',
        format: 'json',
        args: [],
        flags: { threshold: '51' },
      }),
    ).rejects.toThrow(CLIError);
  });

  it('rejects non-numeric --threshold values', async () => {
    const cmd = makeCoverageCommand(async () => summary);
    await expect(
      cmd.run({
        cwd: '/p',
        format: 'json',
        args: [],
        flags: { threshold: 'lots' },
      }),
    ).rejects.toThrow(/threshold/i);
  });

  it('passes ctx.cwd through to the runner as projectRoot', async () => {
    const { fn, calls } = fakeRunner(summary);
    const cmd = makeCoverageCommand(fn);
    await cmd.run({
      cwd: '/some/where',
      format: 'json',
      args: [],
      flags: {},
    });
    expect(calls[0]?.projectRoot).toBe('/some/where');
  });

  it('propagates runner errors as INTERNAL CLIError', async () => {
    const cmd = makeCoverageCommand(async () => {
      throw new Error('vitest blew up');
    });
    await expect(
      cmd.run({ cwd: '/p', format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/vitest blew up/);
  });
});
