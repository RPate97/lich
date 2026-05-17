import { describe, it, expect, beforeEach } from 'vitest';
import { betterAuthAdapter, _resetBetterAuthCacheForTests } from '../../../src/adapters/auth/better-auth';

const ctxFor = (id: string) => ({
  databaseUrl: `sqlite::memory:#${id}`,
  secret: 'test-secret-32-chars-min-length-aaaa',
});

describe('betterAuthAdapter.createUser', () => {
  beforeEach(() => {
    _resetBetterAuthCacheForTests();
  });

  it('creates a user and returns { id, email, name }', async () => {
    const ctx = ctxFor('create-basic');
    const user = await betterAuthAdapter.createUser(ctx, {
      email: 'alice@example.com',
      password: 'hunter2hunter2',
      name: 'Alice',
    });

    expect(user.id).toEqual(expect.any(String));
    expect(user.id.length).toBeGreaterThan(0);
    expect(user.email).toBe('alice@example.com');
    expect(user.name).toBe('Alice');
  });

  it('uses email as name fallback when name is omitted', async () => {
    const ctx = ctxFor('create-noname');
    const user = await betterAuthAdapter.createUser(ctx, {
      email: 'bob@example.com',
      password: 'hunter2hunter2',
    });

    expect(user.id).toEqual(expect.any(String));
    expect(user.email).toBe('bob@example.com');
    // name is required by Better Auth's signUpEmail; we default it to email.
    expect(user.name).toBe('bob@example.com');
  });

  it('throws a clear error when the email already exists', async () => {
    const ctx = ctxFor('dup-email');
    await betterAuthAdapter.createUser(ctx, {
      email: 'carol@example.com',
      password: 'hunter2hunter2',
      name: 'Carol',
    });

    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: 'carol@example.com',
        password: 'hunter2hunter2',
        name: 'Carol Again',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('throws a validation error when email is empty', async () => {
    const ctx = ctxFor('empty-email');
    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: '',
        password: 'hunter2hunter2',
        name: 'Empty',
      }),
    ).rejects.toThrow(/email/i);
  });

  it('throws a validation error when email is whitespace-only', async () => {
    const ctx = ctxFor('ws-email');
    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: '   ',
        password: 'hunter2hunter2',
        name: 'WS',
      }),
    ).rejects.toThrow(/email/i);
  });
});
