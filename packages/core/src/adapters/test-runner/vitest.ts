import { spawn } from 'node:child_process';
import type { TestResult, TestRunInput, TestRunnerAdapter } from './types';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `vitest run [pattern] --reporter=json` and buffer stdout/stderr.
 *
 * Resolves with `{ exitCode, stdout, stderr }` for any clean process exit
 * (including non-zero — failing tests cause a non-zero exit but still produce
 * a valid JSON report on stdout, and the caller wants those counts).
 *
 * Rejects when the OS could not spawn the binary at all (e.g. `ENOENT` when
 * vitest isn't on PATH), surfacing the original Error so callers can match
 * on `.code`.
 */
function runVitest(input: TestRunInput): Promise<SpawnResult> {
  const args: string[] = ['run', '--reporter=json'];
  if (input.pattern) args.push(input.pattern);

  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn('vitest', args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Shape of the vitest --reporter=json payload we care about. Extra fields are
 * ignored; we keep the parser narrow so changes to vitest's report don't
 * silently break us as long as these core fields stick around.
 */
interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  startTime?: number;
  testResults?: Array<{
    startTime?: number;
    endTime?: number;
  }>;
}

function parseReport(stdout: string, stderr: string, exitCode: number): TestResult {
  let report: VitestJsonReport;
  try {
    report = JSON.parse(stdout) as VitestJsonReport;
  } catch (cause) {
    const detail = (stderr || stdout).trim() || `exit ${exitCode}`;
    throw new Error(
      `vitest run failed to produce parseable JSON (exit ${exitCode}): ${detail.slice(0, 500)}`,
      { cause: cause as Error },
    );
  }

  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  // Treat pending + todo as "skipped" — both are non-executed tests from the
  // caller's perspective. The TestResult interface only has a single skipped
  // bucket, so collapsing them is the honest mapping.
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  const total = report.numTotalTests ?? passed + failed + skipped;

  const start = report.startTime ?? 0;
  // vitest doesn't emit a top-level endTime. Reconstruct it from the max
  // per-file endTime; fall back to `start` (durationMs=0) for empty runs.
  const end = (report.testResults ?? []).reduce<number>((max, t) => {
    const e = t.endTime ?? 0;
    return e > max ? e : max;
  }, start);
  const durationMs = Math.max(0, end - start);

  return { passed, failed, skipped, total, durationMs, raw: stdout };
}

export const vitestAdapter: TestRunnerAdapter = {
  name: 'vitest',

  async run(input: TestRunInput): Promise<TestResult> {
    const r = await runVitest(input);

    // Failing tests cause vitest to exit non-zero but still print a valid
    // JSON report. We only treat the run as "broken" when stdout doesn't
    // parse — handled inside parseReport, which surfaces stderr context.
    return parseReport(r.stdout, r.stderr, r.exitCode);
  },
};
