import { spawn } from 'node:child_process';
import type { TestRunnerAdapter, TestRunInput, TestResult } from '@lich/core';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shape of the subset of `playwright test --reporter=json` output we care
 * about. The full schema is in `playwright/types/testReporter.d.ts`
 * (`JSONReport`); we narrow to just `stats` since that's all the
 * `TestResult` interface needs.
 *
 * `flaky` is tests that failed at least once but eventually passed — we count
 * them as passed because the final outcome was success.
 */
interface PlaywrightStats {
  duration: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}

interface PlaywrightJSONReport {
  stats: PlaywrightStats;
}

/**
 * Spawn `npx playwright test ...` and buffer stdout/stderr until exit.
 *
 * Resolves for any clean exit (including non-zero) — Playwright exits non-zero
 * when tests fail but still writes a complete JSON report to stdout, so the
 * caller wants to parse stats even on exit=1. Rejects only when the OS could
 * not spawn the process at all (most commonly `ENOENT`).
 */
function runPlaywright(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn('npx', ['playwright', 'test', ...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
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

export const playwrightTestAdapter: TestRunnerAdapter = {
  name: 'playwright',

  async run(input: TestRunInput): Promise<TestResult> {
    const args = ['--reporter=json'];
    if (input.pattern) {
      args.push(input.pattern);
    }

    const r = await runPlaywright(args, { cwd: input.cwd, env: input.env });

    // Try to parse stdout as the JSON report. Playwright writes the report to
    // stdout even on test failures, so we attempt the parse before bailing on
    // a non-zero exit.
    let report: PlaywrightJSONReport | undefined;
    if (r.stdout.trim().length > 0) {
      try {
        report = JSON.parse(r.stdout) as PlaywrightJSONReport;
      } catch (err) {
        // Fall through: if exit was non-zero we'll surface stderr below.
        // If exit was zero, we have no report at all — propagate the parse
        // error so the caller knows something is wrong.
        if (r.exitCode === 0) {
          throw new Error(
            `playwright test exited 0 but produced unparseable JSON: ${(err as Error).message}`,
          );
        }
      }
    }

    if (!report) {
      const detail = (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`;
      throw new Error(`playwright test failed (exit ${r.exitCode}): ${detail}`);
    }

    const { expected, unexpected, flaky, skipped, duration } = report.stats;
    // Flaky tests are counted as passed (final result was a pass after retry).
    const passed = expected + flaky;
    const failed = unexpected;
    const total = passed + failed + skipped;

    return {
      passed,
      failed,
      skipped,
      total,
      durationMs: duration,
      raw: r.stdout,
    };
  },
};
