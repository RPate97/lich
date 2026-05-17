import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface FileCoverage {
  path: string;
  lines: CoverageMetric;
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
}

export interface CoverageSummary {
  total: {
    lines: CoverageMetric;
    statements: CoverageMetric;
    branches: CoverageMetric;
    functions: CoverageMetric;
  };
  files: FileCoverage[];
}

export interface RunCoverageOptions {
  projectRoot: string;
  /** Override the vitest binary path (default: node_modules/.bin/vitest in projectRoot). */
  vitestBin?: string;
  /** Hard timeout in ms. Default 5 min. */
  timeoutMs?: number;
}

/** Spawn vitest with json-summary coverage, return the parsed summary. */
export async function runCoverage(opts: RunCoverageOptions): Promise<CoverageSummary> {
  const vitestBin = opts.vitestBin ?? join(opts.projectRoot, 'node_modules', '.bin', 'vitest');
  const args = [
    'run',
    '--coverage',
    '--coverage.reporter=json-summary',
    '--coverage.reporter=text',
  ];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(vitestBin, args, { cwd: opts.projectRoot, stdio: 'pipe' });
    const timer = setTimeout(
      () => {
        proc.kill('SIGKILL');
        reject(new Error(`vitest coverage timed out after ${opts.timeoutMs ?? 300_000}ms`));
      },
      opts.timeoutMs ?? 300_000,
    );
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const raw = await readFile(
    join(opts.projectRoot, 'coverage', 'coverage-summary.json'),
    'utf8',
  );
  return parseSummary(JSON.parse(raw) as Record<string, unknown>);
}

function parseSummary(json: Record<string, unknown>): CoverageSummary {
  const total = json.total as Record<string, CoverageMetric>;
  const files: FileCoverage[] = Object.entries(json)
    .filter(([k]) => k !== 'total')
    .map(([path, v]) => {
      const entry = v as Record<string, CoverageMetric>;
      return {
        path,
        lines: entry.lines as CoverageMetric,
        statements: entry.statements as CoverageMetric,
        branches: entry.branches as CoverageMetric,
        functions: entry.functions as CoverageMetric,
      };
    });
  return {
    total: {
      lines: total.lines as CoverageMetric,
      statements: total.statements as CoverageMetric,
      branches: total.branches as CoverageMetric,
      functions: total.functions as CoverageMetric,
    },
    files,
  };
}

/** Returns files whose `lines.pct` is strictly below threshold. */
export function filesBelowThreshold(
  summary: CoverageSummary,
  threshold: number,
): FileCoverage[] {
  return summary.files.filter((f) => f.lines.pct < threshold);
}
