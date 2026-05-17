import { describe, it, expect } from 'vitest';
import { makeBetterAuth, betterAuthAdapter } from '../../../src/adapters/auth/better-auth';

describe('makeBetterAuth', () => {
  it('constructs a Better Auth instance with SQLite in-memory', () => {
    const instance = makeBetterAuth();
    expect(instance).toBeDefined();
    expect(instance.api).toBeDefined();
  });

  it('betterAuthAdapter has the AuthAdapter shape', () => {
    expect(betterAuthAdapter.name).toBe('better-auth');
    expect(typeof betterAuthAdapter.createUser).toBe('function');
    expect(typeof betterAuthAdapter.signSession).toBe('function');
    expect(typeof betterAuthAdapter.inspectSession).toBe('function');
  });

  // Note: signSession and inspectSession are implemented now (LEV-60) — see
  // better-auth.session.test.ts for their behavioral tests.
});
