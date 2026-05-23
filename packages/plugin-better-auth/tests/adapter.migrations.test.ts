import { describe, it, expect, beforeEach } from 'vitest';
import {
  betterAuthAdapter,
  getBetterAuthInstance,
  resetBetterAuthCache,
} from '../src/adapter';
import { getMigrations } from 'better-auth/db/migration';
import type { AuthContext } from '@lich/core';

const TEST_SECRET = 'test-secret-32-chars-min-length-aaaa';

const ctxFor = (id: string): AuthContext => ({
  databaseUrl: `sqlite::memory:#migrations-${id}`,
  secret: TEST_SECRET,
});

/**
 * LEV-118 regression: Better Auth's `runMigrations` issues plain `CREATE TABLE`
 * (no `IF NOT EXISTS`), so a second invocation against the same database would
 * throw `SQLITE_ERROR: table "account" already exists`. The adapter's
 * `ensureMigrated` wraps the call in a try/catch + WeakSet cache so callers
 * (tests, helpers, the adapter's own methods) can run migrations in any order
 * without poisoning the in-memory sqlite test fallback path.
 */
describe('Better Auth migration idempotency (LEV-118)', () => {
  beforeEach(() => {
    resetBetterAuthCache();
  });

  it('runMigrations on the same instance twice does not throw (via adapter)', async () => {
    const ctx = ctxFor('twice-direct');
    const instance = await getBetterAuthInstance(ctx);

    // First run: creates the schema from scratch.
    const first = await getMigrations(instance.options);
    await expect(first.runMigrations()).resolves.toBeUndefined();

    // Second run: Better Auth introspects, sees the tables exist, and produces
    // an empty migration set. This must not throw "already exists".
    const second = await getMigrations(instance.options);
    expect(second.toBeCreated).toHaveLength(0);
    expect(second.toBeAdded).toHaveLength(0);
    await expect(second.runMigrations()).resolves.toBeUndefined();

    // The adapter's own ensureMigrated must also not throw when the schema is
    // already populated — it serializes through the WeakSet cache + try/catch.
    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: 'twice@example.com',
        password: 'hunter2hunter2',
        name: 'Twice',
      }),
    ).resolves.toMatchObject({ email: 'twice@example.com' });
  });

  it('adapter API call after explicit pre-migration succeeds (test bootstrap pattern)', async () => {
    // Mirrors the pattern in adapter.session.test.ts#bootstrapUser: a test pre-
    // migrates by calling $context.runMigrations() before exercising the
    // adapter. The adapter's lazy ensureMigrated must not re-throw on the
    // second migration attempt.
    const ctx = ctxFor('pre-migrate-then-adapter');
    const instance = await getBetterAuthInstance(ctx);
    const context = await instance.$context;
    await context.runMigrations();

    // Now hit the adapter, which internally calls ensureMigrated and triggers
    // a second runMigrations against the already-populated database.
    const user = await betterAuthAdapter.createUser(ctx, {
      email: 'migrate@example.com',
      password: 'hunter2hunter2',
      name: 'Migrator',
    });
    expect(user.email).toBe('migrate@example.com');
  });

  it('adapter handles concurrent createUser calls without migration races', async () => {
    // Concurrent callers each hit ensureMigrated; the WeakSet + try/catch in
    // ensureMigrated must serialize the migration so only one effective
    // CREATE TABLE wins and the others observe "already exists" or skip.
    const ctx = ctxFor('concurrent');
    const results = await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        betterAuthAdapter.createUser(ctx, {
          email: `${tag}@example.com`,
          password: 'hunter2hunter2',
          name: tag.toUpperCase(),
        }),
      ),
    );
    expect(results.map((u) => u.email).sort()).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
  });
});
