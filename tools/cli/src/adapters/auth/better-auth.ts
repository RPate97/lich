import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type {
  AuthAdapter,
  AuthContext,
  CreateUserInput,
  User,
  SessionToken,
  SessionInfo,
} from './types';

export interface BetterAuthInstance {
  // We type this minimally; Better Auth's full shape lives in its own types.
  // Casts to `any` are acceptable here since later tasks will narrow.
  api: any;
  options: any;
  $context: Promise<any>;
}

/** Construct a Better Auth instance configured for SQLite (test/dev). */
export function makeBetterAuth(opts: Partial<BetterAuthOptions> & { database?: any } = {}): BetterAuthInstance {
  // For plan 06.2, the default is SQLite in-memory. Postgres support lands later.
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  return betterAuth({
    database: sqlite,
    secret: 'test-secret-32-chars-min-length-aaaa',
    emailAndPassword: { enabled: true },
    ...opts,
  }) as unknown as BetterAuthInstance;
}

/**
 * Thrown by `inspectSession` when a token is unknown, tampered, or expired.
 * Carries no token data — callers should treat it as opaque "invalid".
 */
export class InvalidSessionError extends Error {
  constructor(reason: 'unknown' | 'expired' = 'unknown') {
    super(`session is invalid (${reason})`);
    this.name = 'InvalidSessionError';
  }
}

/**
 * Cache of Better Auth instances keyed by `(databaseUrl, secret)`. Constructing
 * a Better Auth instance migrates the schema, which is expensive — and for
 * `sqlite::memory:` databases we MUST share the instance across calls, since
 * each handle is its own in-process DB.
 *
 * Tests that need to swap the cached instance (e.g. to inject custom session
 * expiry) call `getBetterAuthInstance` with an `opts` arg, which replaces the
 * cached slot for that key.
 */
const _cache = new Map<string, BetterAuthInstance>();

function cacheKey(ctx: AuthContext): string {
  return `${ctx.databaseUrl}::${ctx.secret}`;
}

/**
 * Look up or lazily build a Better Auth instance for the given context.
 *
 * For test contexts whose databaseUrl starts with `sqlite::memory`, this uses
 * an in-memory better-sqlite3 database. For real Postgres URLs (later) this
 * will dispatch on the URL scheme. If `opts` is supplied, the cached slot is
 * replaced with a freshly-built instance carrying those overrides — useful for
 * tests that need to vary session expiry or other config.
 */
export function getBetterAuthInstance(
  ctx: AuthContext,
  opts?: Partial<BetterAuthOptions>,
): BetterAuthInstance {
  const key = cacheKey(ctx);
  if (!opts && _cache.has(key)) {
    return _cache.get(key)!;
  }
  const isMemorySqlite = ctx.databaseUrl.startsWith('sqlite::memory');
  if (!isMemorySqlite) {
    throw new Error(
      `getBetterAuthInstance: only sqlite::memory:* URLs are supported in plan 06; got ${ctx.databaseUrl}`,
    );
  }
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  const instance = betterAuth({
    database: sqlite,
    secret: ctx.secret,
    emailAndPassword: { enabled: true },
    baseURL: 'http://localhost',
    ...opts,
  }) as unknown as BetterAuthInstance;
  _cache.set(key, instance);
  return instance;
}

/** Test-only: drop all cached Better Auth instances. */
export function resetBetterAuthCache(): void {
  _cache.clear();
}

async function ensureMigrated(instance: BetterAuthInstance): Promise<any> {
  const context = await instance.$context;
  // runMigrations is idempotent for create-if-not-exists DDL.
  await context.runMigrations();
  return context;
}

export const betterAuthAdapter: AuthAdapter = {
  name: 'better-auth',
  async createUser(_ctx: AuthContext, _input: CreateUserInput): Promise<User> {
    throw new Error('better-auth.createUser: not yet implemented (task 06.3)');
  },
  async signSession(ctx: AuthContext, userId: string): Promise<SessionToken> {
    const instance = getBetterAuthInstance(ctx);
    const context = await ensureMigrated(instance);
    const session = await context.internalAdapter.createSession(
      userId,
      /* dontRememberMe */ false,
    );
    if (!session) {
      throw new Error('better-auth.signSession: failed to create session');
    }
    return {
      token: session.token,
      expiresAt: toISO(session.expiresAt),
    };
  },
  async inspectSession(ctx: AuthContext, token: string): Promise<SessionInfo | null> {
    const instance = getBetterAuthInstance(ctx);
    const context = await ensureMigrated(instance);
    const found = await context.internalAdapter.findSession(token);
    if (!found) {
      throw new InvalidSessionError('unknown');
    }
    const { session } = found;
    const expiresAtMs =
      session.expiresAt instanceof Date
        ? session.expiresAt.getTime()
        : new Date(session.expiresAt).getTime();
    if (expiresAtMs <= Date.now()) {
      throw new InvalidSessionError('expired');
    }
    return {
      userId: session.userId,
      expiresAt: toISO(session.expiresAt),
    };
  },
};

function toISO(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
