import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process.spawn so we never shell out to real `playwright test`.
// Each test queues one "spawn result" via setNextSpawn(); the mock pops from
// that queue and also records the args + options it was called with into
// spawnCalls.

interface FakeSpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorCode?: string;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  options?: { cwd?: string; env?: Record<string, string | undefined> };
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

import { playwrightTestAdapter } from '../../src/adapters/test-runner';
import type { TestRunnerAdapter } from '@lich/core';

beforeEach(() => {
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

function makeReport(opts: {
  expected?: number;
  unexpected?: number;
  flaky?: number;
  skipped?: number;
  duration?: number;
}): string {
  return JSON.stringify({
    config: { projects: [] },
    suites: [],
    errors: [],
    stats: {
      startTime: '2025-01-01T00:00:00.000Z',
      duration: opts.duration ?? 0,
      expected: opts.expected ?? 0,
      unexpected: opts.unexpected ?? 0,
      flaky: opts.flaky ?? 0,
      skipped: opts.skipped ?? 0,
    },
  });
}

describe('playwrightTestAdapter', () => {
  it('satisfies the TestRunnerAdapter interface', () => {
    const a: TestRunnerAdapter = playwrightTestAdapter;
    expect(a.name).toBe('playwright');
    expect(typeof a.run).toBe('function');
  });

  it('spawns `playwright test --reporter=json` in the given cwd', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: makeReport({ expected: 3, duration: 1234 }),
    });

    await playwrightTestAdapter.run({ cwd: '/abs/proj' });

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.cmd).toBe('npx');
    expect(call.args[0]).toBe('playwright');
    expect(call.args[1]).toBe('test');
    expect(call.args).toContain('--reporter=json');
    expect(call.options?.cwd).toBe('/abs/proj');
  });

  it('passes pattern as a positional argument when provided', async () => {
    setNextSpawn({ exitCode: 0, stdout: makeReport({ expected: 1, duration: 10 }) });

    await playwrightTestAdapter.run({
      cwd: '/abs/proj',
      pattern: 'tests/e2e/login.spec.ts',
    });

    const call = spawnCalls[0]!;
    expect(call.args).toContain('tests/e2e/login.spec.ts');
  });

  it('merges env into the spawned process env', async () => {
    setNextSpawn({ exitCode: 0, stdout: makeReport({ expected: 1, duration: 5 }) });

    await playwrightTestAdapter.run({
      cwd: '/abs/proj',
      env: { FOO: 'bar', BAZ: 'qux' },
    });

    const call = spawnCalls[0]!;
    expect(call.options?.env).toBeDefined();
    expect(call.options?.env?.FOO).toBe('bar');
    expect(call.options?.env?.BAZ).toBe('qux');
  });

  it('parses passed/failed/skipped/total/durationMs from JSON stats on success', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: makeReport({ expected: 7, unexpected: 0, skipped: 2, duration: 4321 }),
    });

    const result = await playwrightTestAdapter.run({ cwd: '/abs/proj' });
    expect(result.passed).toBe(7);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(9);
    expect(result.durationMs).toBe(4321);
  });

  it('counts flaky tests as passed (final result was success)', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: makeReport({ expected: 5, unexpected: 0, flaky: 2, skipped: 0, duration: 100 }),
    });

    const result = await playwrightTestAdapter.run({ cwd: '/abs/proj' });
    // expected (5) + flaky (2) = 7 passed; flaky tests ultimately passed.
    expect(result.passed).toBe(7);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(7);
  });

  it('parses JSON and reports failures when playwright exits non-zero (test failures)', async () => {
    setNextSpawn({
      exitCode: 1,
      stdout: makeReport({ expected: 4, unexpected: 3, skipped: 1, duration: 999 }),
    });

    const result = await playwrightTestAdapter.run({ cwd: '/abs/proj' });
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(8);
    expect(result.durationMs).toBe(999);
  });

  it('includes raw JSON in the result for downstream inspection', async () => {
    const json = makeReport({ expected: 1, duration: 1 });
    setNextSpawn({ exitCode: 0, stdout: json });

    const result = await playwrightTestAdapter.run({ cwd: '/abs/proj' });
    expect(result.raw).toBe(json);
  });

  it('throws when playwright fails to spawn (e.g. ENOENT)', async () => {
    setNextSpawn({ errorCode: 'ENOENT' });
    await expect(playwrightTestAdapter.run({ cwd: '/abs/proj' })).rejects.toThrow(
      /ENOENT|playwright/,
    );
  });

  it('throws when stdout is not valid JSON and exit code is 0', async () => {
    setNextSpawn({ exitCode: 0, stdout: 'not json at all' });
    await expect(playwrightTestAdapter.run({ cwd: '/abs/proj' })).rejects.toThrow();
  });

  it('throws with stderr context when playwright exits non-zero with no JSON', async () => {
    setNextSpawn({
      exitCode: 1,
      stdout: '',
      stderr: 'config error: no playwright.config.ts found\n',
    });

    await expect(playwrightTestAdapter.run({ cwd: '/abs/proj' })).rejects.toThrow(
      /playwright|config error/i,
    );
  });
});
