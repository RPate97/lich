import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process.spawn so we never actually shell out to vitest from
// inside vitest. Each test queues one "spawn result" via setNextSpawn(); the
// mock pops from that queue and also records the call (cmd/args/options) into
// spawnCalls.

interface FakeSpawnResult {
  stdout?: string;
  stderr?: string;
  // exitCode is what the 'close' event fires with. If errorCode is set, an
  // 'error' event fires *before* close (mirroring ENOENT behaviour where the
  // child process never starts).
  exitCode?: number;
  errorCode?: string;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> } | undefined;
}

const spawnQueue: FakeSpawnResult[] = [];
const spawnCalls: SpawnCall[] = [];

function setNextSpawn(result: FakeSpawnResult): void {
  spawnQueue.push(result);
}

vi.mock('node:child_process', () => {
  return {
    spawn: (
      cmd: string,
      args: string[],
      options?: { cwd?: string; env?: Record<string, string | undefined> },
    ) => {
      spawnCalls.push({ cmd, args, options });
      const next = spawnQueue.shift() ?? { exitCode: 0 };

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        kill: (signal?: string) => boolean;
      };
      proc.stdout = Readable.from([Buffer.from(next.stdout ?? '')]);
      proc.stderr = Readable.from([Buffer.from(next.stderr ?? '')]);
      proc.kill = () => true;

      setImmediate(() => {
        if (next.errorCode) {
          const err = Object.assign(new Error(`spawn ${cmd} ${next.errorCode}`), {
            code: next.errorCode,
          });
          proc.emit('error', err);
          return;
        }
        proc.emit('close', next.exitCode ?? 0);
      });

      return proc;
    },
  };
});

import { vitestAdapter } from '../src/adapter';

beforeEach(() => {
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

// A minimal vitest --reporter=json payload covering one passing, one failing,
// and one skipped test across two files. Top-level startTime is set; per-file
// startTime/endTime drive the overall durationMs.
const sampleVitestJson = JSON.stringify({
  numTotalTestSuites: 2,
  numPassedTestSuites: 1,
  numFailedTestSuites: 1,
  numPendingTestSuites: 0,
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  numTodoTests: 0,
  startTime: 1_000_000,
  success: false,
  testResults: [
    {
      assertionResults: [
        { status: 'passed', title: 'passes', duration: 5 },
      ],
      startTime: 1_000_000,
      endTime: 1_000_050,
      status: 'passed',
      message: '',
      name: '/abs/foo.test.ts',
    },
    {
      assertionResults: [
        { status: 'failed', title: 'fails', duration: 10 },
        { status: 'pending', title: 'skipped', duration: 0 },
      ],
      startTime: 1_000_020,
      endTime: 1_000_200,
      status: 'failed',
      message: 'boom',
      name: '/abs/bar.test.ts',
    },
  ],
});

describe('vitestAdapter', () => {
  it('exposes the adapter name "vitest"', () => {
    expect(vitestAdapter.name).toBe('vitest');
  });

  describe('run()', () => {
    it('shells out `vitest run --reporter=json` with no pattern when none is provided', async () => {
      setNextSpawn({ exitCode: 0, stdout: sampleVitestJson });
      await vitestAdapter.run({ cwd: '/abs/project' });

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.cmd).toBe('vitest');
      expect(spawnCalls[0]?.args).toEqual(['run', '--reporter=json']);
      expect(spawnCalls[0]?.options?.cwd).toBe('/abs/project');
    });

    it('appends the pattern positional when provided', async () => {
      setNextSpawn({ exitCode: 0, stdout: sampleVitestJson });
      await vitestAdapter.run({ cwd: '/abs/project', pattern: 'tests/foo.test.ts' });

      expect(spawnCalls[0]?.args).toEqual(['run', '--reporter=json', 'tests/foo.test.ts']);
    });

    it('merges env into process.env when spawning', async () => {
      setNextSpawn({ exitCode: 0, stdout: sampleVitestJson });
      await vitestAdapter.run({
        cwd: '/abs/project',
        env: { LEVELZERO_TEST_FLAG: 'on' },
      });

      const env = spawnCalls[0]?.options?.env;
      expect(env).toBeDefined();
      // Inherits PATH (or similar) from process.env...
      expect(env?.PATH ?? env?.Path).toBeDefined();
      // ...and includes the caller-provided override.
      expect(env?.LEVELZERO_TEST_FLAG).toBe('on');
    });

    it('parses pass/fail/skip counts and totals from the JSON report', async () => {
      setNextSpawn({ exitCode: 1, stdout: sampleVitestJson });
      const result = await vitestAdapter.run({ cwd: '/abs/project' });

      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(3);
    });

    it('computes durationMs from startTime to the max test endTime', async () => {
      setNextSpawn({ exitCode: 1, stdout: sampleVitestJson });
      const result = await vitestAdapter.run({ cwd: '/abs/project' });

      // start=1_000_000, max endTime across files=1_000_200 → 200ms
      expect(result.durationMs).toBe(200);
    });

    it('includes the raw stdout payload on the result', async () => {
      setNextSpawn({ exitCode: 0, stdout: sampleVitestJson });
      const result = await vitestAdapter.run({ cwd: '/abs/project' });

      expect(result.raw).toBe(sampleVitestJson);
    });

    it('returns counts even when vitest exits non-zero (failed tests are not a spawn error)', async () => {
      setNextSpawn({ exitCode: 1, stdout: sampleVitestJson });
      const result = await vitestAdapter.run({ cwd: '/abs/project' });

      expect(result.total).toBe(3);
      expect(result.failed).toBe(1);
    });

    it('throws when stdout cannot be parsed as JSON', async () => {
      setNextSpawn({ exitCode: 0, stdout: 'not json at all' });
      await expect(vitestAdapter.run({ cwd: '/abs/project' })).rejects.toThrow();
    });

    it('throws when vitest emits an OS-level spawn error (e.g. ENOENT)', async () => {
      setNextSpawn({ errorCode: 'ENOENT' });
      await expect(vitestAdapter.run({ cwd: '/abs/project' })).rejects.toThrow(/ENOENT|vitest/);
    });

    it('throws with stderr context when JSON is missing and exit is non-zero', async () => {
      setNextSpawn({ exitCode: 2, stdout: '', stderr: 'config error\n' });
      await expect(vitestAdapter.run({ cwd: '/abs/project' })).rejects.toThrow(/config error/);
    });

    it('handles a zero-test report cleanly (no NaN duration, all counts zero)', async () => {
      const empty = JSON.stringify({
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: 5_000,
        success: true,
        testResults: [],
      });
      setNextSpawn({ exitCode: 0, stdout: empty });
      const result = await vitestAdapter.run({ cwd: '/abs/project' });

      expect(result.total).toBe(0);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(Number.isFinite(result.durationMs)).toBe(true);
    });
  });
});
