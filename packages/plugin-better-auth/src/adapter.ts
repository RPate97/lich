import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter as betterAuthPrismaAdapter } from 'better-auth/adapters/prisma';
import { getMigrations } from 'better-auth/db/migration';
import {
  CLIError,
  type AuthAdapter,
  type AuthContext,
  type CreateUserInput,
  type ORMAdapter,
  type User,
  type SessionToken,
  type SessionInfo,
} from '@lich/core';

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

/**
 * Construct a Better Auth instance with the given database backend.
 *
 * `database` can be either:
 *   - a Better Auth adapter (from `better-auth/adapters/prisma`, etc.) — the
 *     LEV-173 composability path; or
 *   - a `better-sqlite3` `Database` handle — the in-memory test fallback.
 *
 * If `database` is omitted, falls back to a fresh sqlite `:memory:` handle.
 * The `better-sqlite3` require is lazy and stays in the test path only —
 * after LEV-173 the package's `dependencies` no longer include it
 * (`devDependencies` only), so any non-test caller MUST pass `database`.
 */
export function makeBetterAuth(opts: Partial<BetterAuthOptions> & { database?: any } = {}): BetterAuthInstance {
  const { database: providedDatabase, ...rest } = opts;
  const database = providedDatabase ?? (() => {
    // Lazy require keeps better-sqlite3 off the import graph for any consumer
    // that doesn't fall into this branch. Devs that delete it from
    // devDependencies see this error only when they actually trigger the
    // fallback path (typically: a unit test that didn't wire an ORM).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    return new Database(':memory:');
  })();
  return betterAuth({
    database,
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

/**
 * Whether `ctx.databaseUrl` points at the in-memory sqlite escape hatch.
 * Used by the test-mode fallback when no ORM is wired in.
 */
function isMemorySqliteUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith('sqlite::memory:') || databaseUrl === ':memory:';
}

/**
 * Build the `database` option Better Auth needs, dispatching on the active
 * ORM if one is provided via `ctx.getActiveOrm()`.
 *
 * LEV-173 composability path: when an ORM is active, the auth tables live
 * in the same database the rest of the app reads from. We bind the
 * appropriate Better Auth adapter to the ORM's underlying client, dispatching
 * on `orm.name` to pick the right adapter shape (`@better-auth/prisma-adapter`,
 * future Drizzle/Mongo adapters, …).
 *
 * Last-resort fallback: under `NODE_ENV=test` with no ORM active, fall back
 * to in-memory sqlite. This keeps the existing unit tests (factory,
 * createUser, session, helpers) running without plumbing a fake ORM through
 * every fixture.
 */
async function buildDatabaseForCtx(ctx: AuthContext): Promise<unknown> {
  const orm = ctx.getActiveOrm?.();
  if (orm) {
    if (typeof orm.getClient !== 'function') {
      throw new CLIError(
        'AUTH_NO_ORM',
        `plugin-better-auth: active ORM "${orm.name}" does not implement getClient(); ` +
          `auth cannot share storage with the app's database.`,
        'upgrade the ORM plugin to support getClient (LEV-173), or remove it from the project ' +
          'config so auth falls back to its own store (test-only).',
      );
    }
    const client = await orm.getClient({
      databaseUrl: ctx.databaseUrl,
      projectRoot: process.cwd(),
    });
    switch (orm.name) {
      case 'prisma': {
        const provider = derivePrismaProvider(ctx.databaseUrl);
        return betterAuthPrismaAdapter(client as object, { provider });
      }
      default:
        throw new CLIError(
          'AUTH_NO_ORM',
          `plugin-better-auth: ORM "${orm.name}" is not wired to a Better Auth adapter yet.`,
          'add a dispatch arm in plugin-better-auth/src/adapter.ts (or open an issue)',
        );
    }
  }

  // No ORM. Only the in-memory sqlite test fallback is allowed.
  if (process.env['NODE_ENV'] === 'test' && isMemorySqliteUrl(ctx.databaseUrl)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    return new Database(':memory:');
  }

  throw new CLIError(
    'AUTH_NO_ORM',
    `plugin-better-auth: no active ORM plugin (and not in test fallback mode). ` +
      `databaseUrl=${JSON.stringify(ctx.databaseUrl)}`,
    'load an ORM plugin (e.g. @lich/plugin-prisma) in your lich.config.ts, ' +
      'or set NODE_ENV=test with a sqlite::memory: URL for unit-test fixtures.',
  );
}

/**
 * Map a datasource URL to one of Better Auth's supported `provider` strings.
 * Mirrors `plugin-prisma/src/adapter.ts#deriveDriver` but yields the literal
 * union Better Auth's `PrismaConfig.provider` field expects.
 *
 * Defaults to `'postgresql'` for the LEV-173 v0-template happy path: the
 * stock template wires plugin-postgres + plugin-prisma, so the URL will
 * always be `postgres://...`. Unknown protocols throw an actionable error.
 */
function derivePrismaProvider(
  databaseUrl: string,
): 'sqlite' | 'cockroachdb' | 'mysql' | 'postgresql' | 'sqlserver' | 'mongodb' {
  let protocol = '';
  try {
    protocol = new URL(databaseUrl).protocol.replace(/:$/, '');
  } catch {
    if (databaseUrl.startsWith('file:') || databaseUrl.startsWith('sqlite:')) return 'sqlite';
  }
  switch (protocol) {
    case 'postgres':
    case 'postgresql':
      return 'postgresql';
    case 'mysql':
      return 'mysql';
    case 'file':
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
    case 'mongodb+srv':
      return 'mongodb';
    case 'sqlserver':
      return 'sqlserver';
    case 'cockroachdb':
      return 'cockroachdb';
    default:
      throw new CLIError(
        'AUTH_NO_ORM',
        `plugin-better-auth: cannot derive Better Auth provider from URL ${JSON.stringify(databaseUrl)}.`,
        `supported protocols: postgres(ql), mysql, file/sqlite, mongodb(+srv), sqlserver, cockroachdb`,
      );
  }
}

interface CachedInstance {
  instance: BetterAuthInstance;
  ready: Promise<void>;
}

// Unified cache for Better Auth instances keyed by `(databaseUrl, secret)`.
// Each instance carries a `ready` promise that resolves once the schema has
// been migrated, so concurrent createUser/signSession callers serialize on it.
const _cache = new Map<string, Promise<CachedInstance>>();

function cacheKey(ctx: AuthContext): string {
  return `${ctx.databaseUrl}|${ctx.secret}`;
}

async function buildCached(
  ctx: AuthContext,
  opts?: Partial<BetterAuthOptions>,
): Promise<CachedInstance> {
  const database = await buildDatabaseForCtx(ctx);
  const instance = makeBetterAuth({
    database,
    secret: ctx.secret,
    baseURL: 'http://localhost',
    ...opts,
  });
  // Migration happens lazily on first use via ensureMigrated. We do NOT migrate
  // eagerly here because Better Auth's runMigrations is not idempotent — if a
  // test pre-migrates with `auth.$context.runMigrations()`, a second run blows
  // up with "table already exists". The WeakSet + try/catch in ensureMigrated
  // handles both orderings. For non-sqlite backends (Prisma path), the consumer's
  // ORM migrations own the schema — `ensureMigrated` is a no-op there.
  return { instance, ready: Promise.resolve() };
}

const _migratedInstances = new WeakSet<BetterAuthInstance>();

async function getOrBuildInstance(ctx: AuthContext): Promise<CachedInstance> {
  const key = cacheKey(ctx);
  const existing = _cache.get(key);
  if (existing) return existing;
  // Store the Promise itself in the cache so concurrent callers share the
  // same in-flight build. Errors propagate to all callers but also evict the
  // entry so a retry doesn't get stuck on a poisoned slot.
  const promise = buildCached(ctx).catch((err) => {
    _cache.delete(key);
    throw err;
  });
  _cache.set(key, promise);
  return promise;
}

/**
 * Plan-06 helper used by signSession/inspectSession + tests. Returns the
 * cached Better Auth instance for `ctx`, building one on demand.
 *
 * Always async because constructing a fresh instance may need to resolve
 * the active ORM (`ctx.getActiveOrm()` + `orm.getClient()` are themselves
 * async) — even cache hits go through a Promise so callers don't have to
 * branch on hit/miss. Pre-LEV-173 this returned synchronously for the
 * sqlite case; the callers (tests, helpers) only ever read `.api` or
 * `.$context` (itself a Promise) so adding one extra `await` is benign.
 */
export async function getBetterAuthInstance(
  ctx: AuthContext,
  opts?: Partial<BetterAuthOptions>,
): Promise<BetterAuthInstance> {
  const key = cacheKey(ctx);
  if (!opts) {
    const existing = _cache.get(key);
    if (existing) {
      const cached = await existing;
      return cached.instance;
    }
  }
  // When opts is provided, we still seed the cache so subsequent calls
  // without opts pick up the same (opts-customized) instance. Tests rely
  // on this to "pre-warm" a short-expiry instance via
  // `getBetterAuthInstance(ctx, { session: { expiresIn: 1 } })` before
  // calling adapter methods that re-look-up the cache without opts.
  const promise = buildCached(ctx, opts).catch((err) => {
    _cache.delete(key);
    throw err;
  });
  _cache.set(key, promise);
  const cached = await promise;
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
  // Better Auth's getMigrations() builds a Kysely-backed migrator that only
  // understands the raw database drivers it ships with. When `database` is an
  // adapter function (Prisma/Drizzle path — LEV-173), there's no Kysely
  // connection to migrate against and the consumer's ORM owns the schema
  // anyway. Skip migration in that case; the auth tables come from the
  // project's `prisma/schema.prisma` (see template-v0-stack).
  if (typeof instance.options.database === 'function') {
    _migratedInstances.add(instance);
    return context;
  }
  try {
    const { runMigrations } = await getMigrations(instance.options);
    await runMigrations();
  } catch (err: unknown) {
    // LEV-118: Better Auth's CREATE TABLE statements don't use IF NOT EXISTS,
    // so a second runMigrations call (or one racing with the test's own
    // pre-migration) fails with "table already exists". Swallow that specific
    // failure — the schema is in the desired state either way. Other errors
    // (connectivity, type mismatch, …) still propagate. Regression coverage
    // lives in `tests/adapter.migrations.test.ts`.
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

    const { instance } = await getOrBuildInstance(ctx);
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
    const instance = await getBetterAuthInstance(ctx);
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
    const instance = await getBetterAuthInstance(ctx);
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
    const instance = await getBetterAuthInstance(ctx);
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
