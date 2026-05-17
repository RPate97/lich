import { describe, it, expect, beforeEach } from 'vitest';
import {
  betterAuthAdapter,
  _resetBetterAuthCacheForTests,
  InvalidSessionError,
} from '../../src/adapters/auth/better-auth';
import type { AuthAdapter, AuthContext } from '../../src/adapters/auth/types';
import {
  getOrCreateUser,
  loginAs,
  verifyAndExtractUserId,
} from '../../src/auth/helpers';

const TEST_SECRET = 'test-secret-32-chars-min-length-aaaa';

const ctxFor = (id: string): AuthContext => ({
  databaseUrl: `sqlite::memory:#helpers-${id}`,
  secret: TEST_SECRET,
});

describe('auth/helpers', () => {
  beforeEach(() => {
    _resetBetterAuthCacheForTests();
  });

  describe('getOrCreateUser', () => {
    it('creates a new user when email does not exist', async () => {
      const ctx = ctxFor('create-new');
      const user = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'newbie@example.com',
        password: 'hunter2hunter2',
      });

      expect(user.id).toEqual(expect.any(String));
      expect(user.id.length).toBeGreaterThan(0);
      expect(user.email).toBe('newbie@example.com');
    });

    it('returns the existing user when email is already registered (idempotent)', async () => {
      const ctx = ctxFor('idempotent');
      const first = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'repeat@example.com',
        password: 'hunter2hunter2',
      });
      const second = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'repeat@example.com',
        password: 'different-password-789',
      });
      expect(second.id).toBe(first.id);
      expect(second.email).toBe(first.email);
    });

    it('generates a password when one is not supplied', async () => {
      const ctx = ctxFor('autopassword');
      const user = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'auto@example.com',
      });
      expect(user.id).toEqual(expect.any(String));
      expect(user.email).toBe('auto@example.com');
    });

    it('throws when the adapter has no findUserByEmail and the user already exists', async () => {
      // An adapter without findUserByEmail cannot service idempotency.
      // We surface a clear error rather than silently re-throwing the duplicate.
      const ctx = ctxFor('no-lookup');
      const adapterWithoutLookup: AuthAdapter = {
        name: 'no-lookup',
        createUser: betterAuthAdapter.createUser,
        signSession: betterAuthAdapter.signSession,
        inspectSession: betterAuthAdapter.inspectSession,
      };
      await getOrCreateUser({
        adapter: adapterWithoutLookup,
        ctx,
        email: 'first@example.com',
        password: 'hunter2hunter2',
      });
      await expect(
        getOrCreateUser({
          adapter: adapterWithoutLookup,
          ctx,
          email: 'first@example.com',
          password: 'hunter2hunter2',
        }),
      ).rejects.toThrow(/findUserByEmail/i);
    });
  });

  describe('loginAs', () => {
    it('returns { user, sessionToken, expiresAt } for an existing user', async () => {
      const ctx = ctxFor('login-existing');
      const created = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'login@example.com',
        password: 'hunter2hunter2',
      });
      const { user, sessionToken, expiresAt } = await loginAs({
        adapter: betterAuthAdapter,
        ctx,
        email: 'login@example.com',
      });
      expect(user.id).toBe(created.id);
      expect(typeof sessionToken).toBe('string');
      expect(sessionToken.length).toBeGreaterThan(0);
      const parsed = Date.parse(expiresAt);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(Date.now());
    });

    it('creates a user on the fly when email does not exist (ephemeral)', async () => {
      const ctx = ctxFor('login-new');
      const { user, sessionToken } = await loginAs({
        adapter: betterAuthAdapter,
        ctx,
        email: 'ephemeral@example.com',
      });
      expect(user.email).toBe('ephemeral@example.com');
      expect(sessionToken.length).toBeGreaterThan(0);
    });
  });

  describe('verifyAndExtractUserId', () => {
    it('extracts userId from a valid token', async () => {
      const ctx = ctxFor('verify-ok');
      const { user, sessionToken } = await loginAs({
        adapter: betterAuthAdapter,
        ctx,
        email: 'verify@example.com',
      });
      const { userId } = await verifyAndExtractUserId({
        adapter: betterAuthAdapter,
        ctx,
        token: sessionToken,
      });
      expect(userId).toBe(user.id);
    });

    it('throws on a tampered token', async () => {
      const ctx = ctxFor('verify-tamper');
      const { sessionToken } = await loginAs({
        adapter: betterAuthAdapter,
        ctx,
        email: 'tamper@example.com',
      });
      const tampered =
        sessionToken.slice(0, -1) + (sessionToken.slice(-1) === 'a' ? 'b' : 'a');
      await expect(
        verifyAndExtractUserId({
          adapter: betterAuthAdapter,
          ctx,
          token: tampered,
        }),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    });

    it('throws on a totally fake token', async () => {
      const ctx = ctxFor('verify-fake');
      await expect(
        verifyAndExtractUserId({
          adapter: betterAuthAdapter,
          ctx,
          token: 'not-a-real-token-at-all',
        }),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    });
  });

  describe('round-trip (create -> login -> verify)', () => {
    it('composes cleanly across all three helpers', async () => {
      const ctx = ctxFor('roundtrip');
      const created = await getOrCreateUser({
        adapter: betterAuthAdapter,
        ctx,
        email: 'rt@example.com',
        password: 'hunter2hunter2',
      });
      const { sessionToken } = await loginAs({
        adapter: betterAuthAdapter,
        ctx,
        email: 'rt@example.com',
      });
      const { userId } = await verifyAndExtractUserId({
        adapter: betterAuthAdapter,
        ctx,
        token: sessionToken,
      });
      expect(userId).toBe(created.id);
    });
  });
});
