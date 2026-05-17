import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  AuthAdapter,
  AuthContext,
  CreateUserInput,
  User,
  SessionToken,
  SessionInfo,
} from '../../../src/adapters/auth/types';

describe('AuthAdapter types', () => {
  it('AuthContext carries connection + secret', () => {
    const ctx: AuthContext = { databaseUrl: 'postgres://...', secret: 'test-secret-32-chars-min-length-aaaa' };
    expect(ctx.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('CreateUserInput accepts email + password', () => {
    const i: CreateUserInput = { email: 'a@b.com', password: 'hunter2hunter2', name: 'A' };
    expect(i.email).toBe('a@b.com');
  });

  it('User has stable id + email', () => {
    const u: User = { id: 'u_123', email: 'a@b.com', name: 'A', createdAt: new Date().toISOString() };
    expect(u.id).toMatch(/^u_/);
  });

  it('SessionToken carries the token + ISO8601 expiry', () => {
    const t: SessionToken = { token: 'eyJ...', expiresAt: new Date().toISOString() };
    expect(typeof t.token).toBe('string');
    expect(typeof t.expiresAt).toBe('string');
  });

  it('SessionInfo identifies the user and expiry', () => {
    const s: SessionInfo = { userId: 'u_123', expiresAt: new Date().toISOString() };
    expect(s.userId).toMatch(/^u_/);
  });

  it('AuthAdapter has the expected method shape', () => {
    expectTypeOf<AuthAdapter>().toMatchTypeOf<{
      name: string;
      createUser(ctx: AuthContext, input: CreateUserInput): Promise<User>;
      signSession(ctx: AuthContext, userId: string): Promise<SessionToken>;
      inspectSession(ctx: AuthContext, token: string): Promise<SessionInfo | null>;
    }>();
  });
});
