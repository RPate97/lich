import { describe, test, expectTypeOf } from 'vitest';
import type { SandboxBackend, SandboxConfig, SandboxState, ExecResult } from '../../../src/sandbox/backend.js';

describe('SandboxBackend interface contract', () => {
  test('method signatures match documented shapes', () => {
    expectTypeOf<SandboxBackend['create']>().parameters.toEqualTypeOf<[SandboxConfig]>();
    expectTypeOf<SandboxBackend['create']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<SandboxBackend['inspect']>().returns.toEqualTypeOf<Promise<SandboxState>>();
    expectTypeOf<SandboxBackend['exec']>().returns.toEqualTypeOf<Promise<ExecResult>>();
    expectTypeOf<SandboxBackend['list']>().returns.toEqualTypeOf<Promise<ReadonlyArray<SandboxState>>>();
  });
});
