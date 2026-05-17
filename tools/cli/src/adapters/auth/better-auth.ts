import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import type { AuthAdapter, AuthContext, CreateUserInput, User, SessionToken, SessionInfo } from './types';

export interface BetterAuthInstance {
  // We type this minimally; Better Auth's full shape lives in its own types.
  // Casts to `any` are acceptable here since later tasks will narrow.
  api: any;
  options: any;
}

// Node 18 ships without a global `crypto`, but Better Auth's id generator and
// password hasher both expect `globalThis.crypto`. We polyfill once at module
// load time so callers don't have to think about it.
if (typeof (globalThis as any).crypto === 'undefined') {
  // Lazy require to avoid pulling in node:crypto on environments that already
  // have the Web Crypto API exposed globally (Node 19+, Bun, Deno).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { webcrypto } = require('node:crypto');
  (globalThis as any).crypto = webcrypto;
}

/** Construct a Better Auth instance configured for SQLite (test/dev). */
export function makeBetterAuth(opts: Partial<BetterAuthOptions> & { database?: any } = {}): BetterAuthInstance {
  // For plan 06.2, the default is SQLite in-memory. Postgres support lands later.
  const Database = require('better-sqlite3');
  const sqlite = opts.database ?? new Database(':memory:');
  const { database: _ignored, ...rest } = opts;
  return betterAuth({
    database: sqlite,
    secret: 'test-secret-32-chars-min-length-aaaa',
    emailAndPassword: { enabled: true },
    ...rest,
  }) as unknown as BetterAuthInstance;
}

interface CachedInstance {
  instance: BetterAuthInstance;
  ready: Promise<void>;
}

// Module-level cache so repeated `createUser` calls against the same
// (databaseUrl, secret) share state — required for the "lookup returns the
// same record" and "duplicate email errors" behaviors.
const instanceCache = new Map<string, CachedInstance>();

/** Test-only: clear the cached Better Auth instances. */
export function _resetBetterAuthCacheForTests(): void {
  instanceCache.clear();
}

function cacheKey(ctx: AuthContext): string {
  return `${ctx.databaseUrl}|${ctx.secret}`;
}

function getOrBuildInstance(ctx: AuthContext): CachedInstance {
  const key = cacheKey(ctx);
  const existing = instanceCache.get(key);
  if (existing) return existing;

  // Any non-empty `sqlite::memory:` form (e.g. `sqlite::memory:#test1`) maps to
  // a fresh in-memory SQLite db. The fragment lets tests get isolated state
  // without changing the resolver.
  const isMemorySqlite = ctx.databaseUrl.startsWith('sqlite::memory:') || ctx.databaseUrl === ':memory:';
  if (!isMemorySqlite) {
    throw new Error(
      `betterAuthAdapter: unsupported databaseUrl ${JSON.stringify(ctx.databaseUrl)}. ` +
        `Only sqlite::memory: is supported in plan 06; Postgres lands in a later plan.`,
    );
  }

  const instance = makeBetterAuth({ secret: ctx.secret });
  const ready = (async () => {
    const { runMigrations } = await getMigrations(instance.options);
    await runMigrations();
  })();

  const cached: CachedInstance = { instance, ready };
  instanceCache.set(key, cached);
  return cached;
}

function isDuplicateEmailError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { body?: { code?: string }; message?: string };
  if (anyErr.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return true;
  if (anyErr.body?.code === 'USER_ALREADY_EXISTS') return true;
  return typeof anyErr.message === 'string' && /already exists/i.test(anyErr.message);
}

export const betterAuthAdapter: AuthAdapter = {
  name: 'better-auth',
  async createUser(ctx: AuthContext, input: CreateUserInput): Promise<User> {
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (email.length === 0) {
      throw new Error('better-auth.createUser: email is required');
    }
    if (typeof input.password !== 'string' || input.password.length === 0) {
      throw new Error('better-auth.createUser: password is required');
    }

    const { instance, ready } = getOrBuildInstance(ctx);
    await ready;

    // Better Auth's signUpEmail requires `name`. We default to the email so
    // callers that don't care about display names can omit it.
    const name = input.name && input.name.length > 0 ? input.name : email;

    let result: any;
    try {
      result = await instance.api.signUpEmail({
        body: { email, password: input.password, name },
      });
    } catch (err) {
      if (isDuplicateEmailError(err)) {
        throw new Error(`better-auth.createUser: user with email ${email} already exists`);
      }
      throw err;
    }

    const user = result?.user;
    if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') {
      throw new Error('better-auth.createUser: unexpected response shape from Better Auth');
    }

    return {
      id: user.id,
      email: user.email,
      name: typeof user.name === 'string' ? user.name : undefined,
      createdAt:
        typeof user.createdAt === 'string'
          ? user.createdAt
          : user.createdAt instanceof Date
            ? user.createdAt.toISOString()
            : new Date().toISOString(),
    };
  },
  async signSession(_ctx: AuthContext, _userId: string): Promise<SessionToken> {
    throw new Error('better-auth.signSession: not yet implemented (task 06.4)');
  },
  async inspectSession(_ctx: AuthContext, _token: string): Promise<SessionInfo | null> {
    throw new Error('better-auth.inspectSession: not yet implemented (task 06.4)');
  },
};
