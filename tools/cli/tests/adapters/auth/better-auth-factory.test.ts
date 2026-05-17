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

  it('createUser throws not-yet-implemented in plan 06.2', async () => {
    await expect(
      betterAuthAdapter.createUser({ databaseUrl: 'postgres://', secret: 'x'.repeat(32) }, { email: 'a@b', password: 'x' }),
    ).rejects.toThrow(/not yet implemented/);
  });
});
