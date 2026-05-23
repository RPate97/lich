import { describe, it, expect, beforeEach } from 'vitest';
import {
  betterAuthAdapter,
  _resetBetterAuthCacheForTests,
} from '../src/adapter';
import { CLIError, type AuthContext, type ORMAdapter } from '@lich/core';

/**
 * LEV-173 — auth adapter consumes the active ORM (no hardcoded sqlite).
 *
 * These tests use a fake `ORMAdapter` whose `getClient` returns a sentinel
 * value. The Better Auth Prisma adapter doesn't actually issue queries
 * until createUser/signSession run, so we can stop short of executing a
 * full round-trip and just assert that the dispatch reaches the prisma path
 * (and surfaces a recognizable error when the fake client doesn't satisfy
 * the adapter's expectations).
 */
const TEST_SECRET = 'test-secret-32-chars-min-length-aaaa';

/**
 * Minimal fake of a `PrismaClient` shape. The Better Auth Prisma adapter
 * pokes at `db[modelName].create/findUnique/...` — we record calls so
 * the test can assert the dispatch landed on the prisma path. Each method
 * throws a recognizable error so we don't need a real database behind it.
 */
function makeFakePrismaClient() {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const make = (model: string) => {
    return new Proxy(
      {},
      {
        get(_target, method: string) {
          return (args: unknown) => {
            calls.push({ model, method, args });
            throw new Error(`fake-prisma:${model}.${method}-called`);
          };
        },
      },
    );
  };
  // Better Auth Prisma adapter uses lowercased model names by default.
  return {
    user: make('user'),
    session: make('session'),
    account: make('account'),
    verification: make('verification'),
    _calls: calls,
  };
}

function makeFakePrismaOrm(client: ReturnType<typeof makeFakePrismaClient>): ORMAdapter {
  return {
    name: 'prisma',
    applyMigrations: async () => ({ applied: 0, names: [], output: '' }),
    newMigration: async (_ctx, name) => ({ path: '', name }),
    seed: async () => ({ ok: true, output: '' }),
    inspectSchema: async () => ({ tables: {} }),
    inspectTable: async () => [],
    resetDatabase: async () => undefined,
    generateClient: async () => undefined,
    getClient: () => client,
  };
}

describe('betterAuthAdapter — active ORM dispatch (LEV-173)', () => {
  beforeEach(() => {
    _resetBetterAuthCacheForTests();
  });

  it('routes through the prisma adapter when `getActiveOrm` returns a prisma impl', async () => {
    const client = makeFakePrismaClient();
    const orm = makeFakePrismaOrm(client);
    const ctx: AuthContext = {
      databaseUrl: 'postgres://user:pw@localhost:5432/db',
      secret: TEST_SECRET,
      getActiveOrm: () => orm,
    };

    // The first call to createUser will route to Better Auth's prisma adapter,
    // which dispatches to `client.user.findUnique` / `client.account.create`
    // (and `client.user.create` for signUp). All of those raise our recognizable
    // fake-prisma error. We just need ONE of them to land so we know dispatch
    // hit the prisma path — Better Auth's signUpEmail rewraps internal errors,
    // so we settle for "the call was recorded on the fake client".
    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: 'alice@example.com',
        password: 'hunter2hunter2',
        name: 'Alice',
      }),
    ).rejects.toBeDefined();

    // The exact first method depends on Better Auth's internal sequence, but
    // it must have touched at least one of the auth tables on the fake client.
    expect(client._calls.length).toBeGreaterThan(0);
    const touchedModels = new Set(client._calls.map((c) => c.model));
    // We expect at minimum a lookup or create against `user` or `account`.
    expect(
      touchedModels.has('user') || touchedModels.has('account'),
    ).toBe(true);
  });

  it('throws AUTH_NO_ORM when the active ORM lacks getClient', async () => {
    const orm: ORMAdapter = {
      name: 'prisma',
      applyMigrations: async () => ({ applied: 0, names: [], output: '' }),
      newMigration: async (_ctx, name) => ({ path: '', name }),
      seed: async () => ({ ok: true, output: '' }),
      inspectSchema: async () => ({ tables: {} }),
      inspectTable: async () => [],
      resetDatabase: async () => undefined,
      generateClient: async () => undefined,
      // No getClient!
    };
    const ctx: AuthContext = {
      databaseUrl: 'postgres://localhost/db',
      secret: TEST_SECRET,
      getActiveOrm: () => orm,
    };

    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: 'bob@example.com',
        password: 'hunter2hunter2',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_NO_ORM' });
  });

  it('throws AUTH_NO_ORM when ORM name is unknown to the dispatch', async () => {
    const orm: ORMAdapter = {
      name: 'mongoose', // not yet wired
      applyMigrations: async () => ({ applied: 0, names: [], output: '' }),
      newMigration: async (_ctx, name) => ({ path: '', name }),
      seed: async () => ({ ok: true, output: '' }),
      inspectSchema: async () => ({ tables: {} }),
      inspectTable: async () => [],
      resetDatabase: async () => undefined,
      generateClient: async () => undefined,
      getClient: () => ({}),
    };
    const ctx: AuthContext = {
      databaseUrl: 'mongodb://localhost/db',
      secret: TEST_SECRET,
      getActiveOrm: () => orm,
    };

    await expect(
      betterAuthAdapter.createUser(ctx, {
        email: 'eve@example.com',
        password: 'hunter2hunter2',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_NO_ORM' });
  });

  it('falls back to sqlite::memory when no ORM is active under NODE_ENV=test', async () => {
    // This path is exercised by the existing sqlite-backed unit tests
    // (createUser, helpers, session). Re-asserting here documents the
    // contract: when getActiveOrm is absent or returns undefined, the
    // adapter still works against in-memory sqlite, which is what every
    // other test in this package relies on.
    const ctx: AuthContext = {
      databaseUrl: 'sqlite::memory:fallback-doc',
      secret: TEST_SECRET,
      getActiveOrm: () => undefined,
    };
    const user = await betterAuthAdapter.createUser(ctx, {
      email: 'fallback@example.com',
      password: 'hunter2hunter2',
      name: 'Fallback',
    });
    expect(user.email).toBe('fallback@example.com');
  });

  it('CLIError errors carry the AUTH_NO_ORM code as a `code` property', async () => {
    // Sanity: ensure we surface the CLIError so callers can inspect `code`.
    const ctx: AuthContext = {
      databaseUrl: 'postgres://localhost/db',
      secret: TEST_SECRET,
      // Returning undefined when not in test mode would also trigger
      // AUTH_NO_ORM, but we cover that in adapter integration paths. Here we
      // hit the "unknown ORM name" branch which is purely synchronous.
      getActiveOrm: () => ({
        name: 'drizzle',
        applyMigrations: async () => ({ applied: 0, names: [], output: '' }),
        newMigration: async (_ctx, name) => ({ path: '', name }),
        seed: async () => ({ ok: true, output: '' }),
        inspectSchema: async () => ({ tables: {} }),
        inspectTable: async () => [],
        resetDatabase: async () => undefined,
        generateClient: async () => undefined,
        getClient: () => ({}),
      }),
    };
    try {
      await betterAuthAdapter.createUser(ctx, {
        email: 'x@example.com',
        password: 'hunter2hunter2',
      });
      throw new Error('expected createUser to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CLIError);
      expect((err as CLIError).code).toBe('AUTH_NO_ORM');
    }
  });
});
