import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  TestResult,
  TestRunInput,
  TestRunnerAdapter,
} from '../../../src/adapters/test-runner/types';

describe('TestRunnerAdapter types', () => {
  it('TestResult carries counts and duration', () => {
    const r: TestResult = {
      passed: 10,
      failed: 1,
      skipped: 2,
      total: 13,
      durationMs: 1234,
    };
    expect(r.passed).toBe(10);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.total).toBe(13);
    expect(r.durationMs).toBe(1234);
  });

  it('TestResult allows optional raw output', () => {
    const r: TestResult = {
      passed: 1,
      failed: 0,
      skipped: 0,
      total: 1,
      durationMs: 5,
      raw: 'pass: tests/foo.test.ts',
    };
    expect(r.raw).toContain('pass');
  });

  it('TestRunInput requires a cwd and allows optional fields', () => {
    const minimal: TestRunInput = { cwd: '/abs/path' };
    expect(minimal.cwd).toBe('/abs/path');

    const full: TestRunInput = {
      cwd: '/abs/path',
      pattern: '**/*.test.ts',
      env: { NODE_ENV: 'test' },
      watch: false,
      timeoutMs: 60_000,
    };
    expect(full.pattern).toBe('**/*.test.ts');
    expect(full.env?.NODE_ENV).toBe('test');
    expect(full.watch).toBe(false);
    expect(full.timeoutMs).toBe(60_000);
  });

  it('TestRunnerAdapter has name + run(input) shape', () => {
    expectTypeOf<TestRunnerAdapter>().toMatchTypeOf<{
      name: string;
      run(input: TestRunInput): Promise<TestResult>;
    }>();
  });

  it('mock adapter implementing the interface compiles and runs', async () => {
    const mock: TestRunnerAdapter = {
      name: 'mock',
      async run(input: TestRunInput): Promise<TestResult> {
        return {
          passed: 1,
          failed: 0,
          skipped: 0,
          total: 1,
          durationMs: 1,
          raw: `cwd=${input.cwd}`,
        };
      },
    };

    expect(mock.name).toBe('mock');
    const result = await mock.run({ cwd: '/tmp/example' });
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.raw).toBe('cwd=/tmp/example');
  });
});
