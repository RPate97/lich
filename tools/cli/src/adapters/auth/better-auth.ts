import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { AuthAdapter, AuthContext, CreateUserInput, User, SessionToken, SessionInfo } from './types';

export interface BetterAuthInstance {
  // We type this minimally; Better Auth's full shape lives in its own types.
  // Casts to `any` are acceptable here since later tasks will narrow.
  api: any;
  options: any;
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

/** Skeleton adapter — methods are filled in by tasks 06.3 + 06.4. */
export const betterAuthAdapter: AuthAdapter = {
  name: 'better-auth',
  async createUser(_ctx: AuthContext, _input: CreateUserInput): Promise<User> {
    throw new Error('better-auth.createUser: not yet implemented (task 06.3)');
  },
  async signSession(_ctx: AuthContext, _userId: string): Promise<SessionToken> {
    throw new Error('better-auth.signSession: not yet implemented (task 06.4)');
  },
  async inspectSession(_ctx: AuthContext, _token: string): Promise<SessionInfo | null> {
    throw new Error('better-auth.inspectSession: not yet implemented (task 06.4)');
  },
};
