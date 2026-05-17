import { CLIError } from '../errors';
import {
  filesBelowThreshold,
  runCoverage as defaultRunCoverage,
  type CoverageSummary,
  type RunCoverageOptions,
} from '../coverage/runner';
import type { Command } from './types';

export type RunCoverageFn = (opts: RunCoverageOptions) => Promise<CoverageSummary>;

function parseThreshold(flags: Record<string, string | boolean>): number | null {
  const raw = flags['threshold'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    // bare --threshold without a value is not meaningful for a numeric flag
    throw new CLIError(
      'CONFIG_INVALID',
      '--threshold requires a numeric value',
      'example: --threshold 80',
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CLIError(
      'CONFIG_INVALID',
      `invalid --threshold value: ${raw} (expected a number)`,
      'example: --threshold 80',
    );
  }
  return n;
}

export function makeCoverageCommand(runCoverage: RunCoverageFn = defaultRunCoverage): Command {
  return {
    name: 'coverage',
    describe: 'Run the project test suite with coverage and emit a JSON summary',
    async run(ctx) {
      const threshold = parseThreshold(ctx.flags);
      const summary = await runCoverage({ projectRoot: ctx.cwd });
      if (threshold !== null) {
        const offenders = filesBelowThreshold(summary, threshold);
        if (offenders.length > 0) {
          throw new CLIError(
            'COVERAGE_THRESHOLD',
            `${offenders.length} file(s) below ${threshold}% line coverage`,
            {
              hint: 'raise coverage for the listed files or lower --threshold',
              details: {
                threshold,
                files: offenders.map((f) => ({ path: f.path, pct: f.lines.pct })),
              },
            },
          );
        }
      }
      return summary;
    },
  };
}

export const coverageCommand: Command = makeCoverageCommand();
