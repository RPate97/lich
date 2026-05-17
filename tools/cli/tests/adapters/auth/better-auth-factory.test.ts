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

  it('signSession throws not-yet-implemented in plan 06.3', async () => {
    await expect(
      betterAuthAdapter.signSession({ databaseUrl: 'sqlite::memory:', secret: 'x'.repeat(32) }, 'u_1'),
    ).rejects.toThrow(/not yet implemented/);
  });

  it('inspectSession throws not-yet-implemented in plan 06.3', async () => {
    await expect(
      betterAuthAdapter.inspectSession({ databaseUrl: 'sqlite::memory:', secret: 'x'.repeat(32) }, 'tok'),
    ).rejects.toThrow(/not yet implemented/);
  });
});
