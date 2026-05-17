import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
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

interface CachedInstance {
  instance: BetterAuthInstance;
  ready: Promise<void>;
}

// Unified cache for Better Auth instances keyed by `(databaseUrl, secret)`.
// Each instance carries a `ready` promise that resolves once the schema has
// been migrated, so concurrent createUser/signSession callers serialize on it.
const _cache = new Map<string, CachedInstance>();

function cacheKey(ctx: AuthContext): string {
  return `${ctx.databaseUrl}|${ctx.secret}`;
}

function buildCached(ctx: AuthContext, opts?: Partial<BetterAuthOptions>): CachedInstance {
  const instance = makeBetterAuth({ secret: ctx.secret, baseURL: 'http://localhost', ...opts });
  // Migration happens lazily on first use via ensureMigrated. We do NOT migrate
  // eagerly here because Better Auth's runMigrations is not idempotent — if a
  // test pre-migrates with `auth.$context.runMigrations()`, a second run blows
  // up with "table already exists". The WeakSet + try/catch in ensureMigrated
  // handles both orderings.
  return { instance, ready: Promise.resolve() };
}

const _migratedInstances = new WeakSet<BetterAuthInstance>();

function getOrBuildInstance(ctx: AuthContext): CachedInstance {
  const key = cacheKey(ctx);
  const existing = _cache.get(key);
  if (existing) return existing;
  const isMemorySqlite =
    ctx.databaseUrl.startsWith('sqlite::memory:') || ctx.databaseUrl === ':memory:';
  if (!isMemorySqlite) {
    throw new Error(
      `betterAuthAdapter: unsupported databaseUrl ${JSON.stringify(ctx.databaseUrl)}. ` +
        `Only sqlite::memory: is supported in plan 06; Postgres lands in a later plan.`,
    );
  }
  const cached = buildCached(ctx);
  _cache.set(key, cached);
  return cached;
}

/** Plan-06 helper used by signSession/inspectSession; mirrors getOrBuildInstance
 *  but returns the instance directly and supports per-test opts overrides. */
export function getBetterAuthInstance(
  ctx: AuthContext,
  opts?: Partial<BetterAuthOptions>,
): BetterAuthInstance {
  const key = cacheKey(ctx);
  if (!opts && _cache.has(key)) return _cache.get(key)!.instance;
  const isMemorySqlite =
    ctx.databaseUrl.startsWith('sqlite::memory:') || ctx.databaseUrl === ':memory:';
  if (!isMemorySqlite) {
    throw new Error(
      `getBetterAuthInstance: only sqlite::memory:* URLs are supported in plan 06; got ${ctx.databaseUrl}`,
    );
  }
  const cached = buildCached(ctx, opts);
  _cache.set(key, cached);
  return cached.instance;
}

/** Test-only: clear all cached Better Auth instances. */
export function _resetBetterAuthCacheForTests(): void {
  _cache.clear();
}

/** Alias of `_resetBetterAuthCacheForTests` — same behavior, different name. */
export function resetBetterAuthCache(): void {
  _cache.clear();
}

async function ensureMigrated(instance: BetterAuthInstance): Promise<any> {
  const context = await instance.$context;
  if (_migratedInstances.has(instance)) return context;
  try {
    const { runMigrations } = await getMigrations(instance.options);
    await runMigrations();
  } catch (err: unknown) {
    // Better Auth's CREATE TABLE statements don't use IF NOT EXISTS, so a
    // second runMigrations call (or one racing with the test's own pre-migration)
    // fails. Swallow "already exists" errors — the schema is in the desired
    // state either way.
    const e = err as { code?: string; message?: string };
    if (e.code !== 'SQLITE_ERROR' || !/already exists/i.test(e.message ?? '')) {
      throw err;
    }
  }
  _migratedInstances.add(instance);
  return context;
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

    const { instance } = getOrBuildInstance(ctx);
    await ensureMigrated(instance);

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
  async findUserByEmail(ctx: AuthContext, email: string): Promise<User | null> {
    const trimmed = typeof email === 'string' ? email.trim() : '';
    if (trimmed.length === 0) return null;
    const instance = getBetterAuthInstance(ctx);
    const context = await ensureMigrated(instance);
    const user = await context.internalAdapter.findUserByEmail(trimmed);
    if (!user) return null;
    // Better Auth's findUserByEmail returns `{ ...user, accounts? }`.
    // When `accounts` is unrequested we still get a bare user object.
    const u = (user as any).user ?? user;
    if (!u || typeof u.id !== 'string' || typeof u.email !== 'string') return null;
    return {
      id: u.id,
      email: u.email,
      name: typeof u.name === 'string' ? u.name : undefined,
      createdAt:
        typeof u.createdAt === 'string'
          ? u.createdAt
          : u.createdAt instanceof Date
            ? u.createdAt.toISOString()
            : new Date().toISOString(),
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
