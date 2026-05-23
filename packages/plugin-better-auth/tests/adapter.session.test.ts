import { describe, it, expect, beforeAll } from 'vitest';
import {
  betterAuthAdapter,
  getBetterAuthInstance,
  InvalidSessionError,
  resetBetterAuthCache,
} from '../src/adapter';
import type { AuthContext } from '@lich/core';

const TEST_SECRET = 'test-secret-32-chars-min-length-aaaa';

/**
 * Bootstrap a real user via Better Auth's signUpEmail API.
 *
 * LEV-59 (createUser adapter method) is being implemented concurrently in the
 * same file, so this test cannot rely on betterAuthAdapter.createUser. Drop
 * down to the Better Auth API directly.
 */
async function bootstrapUser(ctx: AuthContext): Promise<string> {
  const auth = await getBetterAuthInstance(ctx);
  // Migrations must run before signUpEmail can write to the `user` table.
  // The adapter itself runs them lazily inside signSession/inspectSession.
  const context = await auth.$context;
  await context.runMigrations();
  const result = (await auth.api.signUpEmail({
    body: {
      email: `user-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'hunter2hunter2',
      name: 'Test User',
    },
    headers: new Headers({ host: 'localhost' }),
  })) as { user: { id: string } };
  return result.user.id;
}

describe('betterAuthAdapter.signSession + inspectSession', () => {
  describe('round-trip', () => {
    const ctx: AuthContext = { databaseUrl: 'sqlite::memory:rt', secret: TEST_SECRET };
    let userId: string;

    beforeAll(async () => {
      resetBetterAuthCache();
      userId = await bootstrapUser(ctx);
    });

    it('signSession returns a token + ISO8601 expiresAt in the future', async () => {
      const { token, expiresAt } = await betterAuthAdapter.signSession(ctx, userId);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      const parsed = Date.parse(expiresAt);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(Date.now());
    });

    it('inspectSession round-trips userId + expiresAt', async () => {
      const { token, expiresAt } = await betterAuthAdapter.signSession(ctx, userId);
      const info = await betterAuthAdapter.inspectSession(ctx, token);
      expect(info).not.toBeNull();
      expect(info!.userId).toBe(userId);
      expect(info!.expiresAt).toBe(expiresAt);
    });
  });

  describe('rejection paths', () => {
    const ctx: AuthContext = { databaseUrl: 'sqlite::memory:rej', secret: TEST_SECRET };
    let userId: string;

    beforeAll(async () => {
      resetBetterAuthCache();
      userId = await bootstrapUser(ctx);
    });

    it('throws InvalidSessionError for a tampered token', async () => {
      const { token } = await betterAuthAdapter.signSession(ctx, userId);
      const tampered =
        token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
      await expect(
        betterAuthAdapter.inspectSession(ctx, tampered),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    });

    it('throws InvalidSessionError for a completely fake token', async () => {
      await expect(
        betterAuthAdapter.inspectSession(ctx, 'not-a-real-token'),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    });
  });

  describe('expiry', () => {
    it('throws InvalidSessionError for an expired token', async () => {
      const ctx: AuthContext = {
        databaseUrl: 'sqlite::memory:exp',
        secret: TEST_SECRET,
      };
      resetBetterAuthCache();
      // Override the cache slot with a short-expiry instance before any other
      // adapter call. The adapter's cache key is (databaseUrl, secret) and the
      // factory pulls expiry from sessionConfig in opts.
      await getBetterAuthInstance(ctx, { session: { expiresIn: 1 } });
      const userId = await bootstrapUser(ctx);

      const { token } = await betterAuthAdapter.signSession(ctx, userId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(
        betterAuthAdapter.inspectSession(ctx, token),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    });
  });
});
