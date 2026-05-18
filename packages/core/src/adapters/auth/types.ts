/**
 * AuthAdapter — pluggable interface for the auth slot.
 *
 * Hypothetical alternative implementations:
 *   - BetterAuth  (current default; ships in `@levelzero/plugin-better-auth`)
 *   - Clerk       (managed identity service; sessions issued by Clerk's API)
 *   - Auth.js     (NextAuth; OAuth-first with optional credentials)
 *   - Lucia       (session-cookie focused, DB-backed)
 *   - WorkOS      (enterprise SSO/SAML)
 *
 * Consumer-POV: callers want to "create a user", "mint a session for them",
 * "validate an incoming session reference". They don't care whether the
 * session is a JWT, an opaque token in a DB, a Clerk-managed session id, or
 * a signed cookie — the contract only exposes the reference as an opaque
 * string (`SessionToken.token`) and an expiry timestamp.
 *
 * Any impl in this slot MUST consume the active ORM (and through it the
 * active `DatabaseProvider`) for its persistence needs — auth plugins do
 * not bring their own database driver to the party. See
 * `docs/EXTENSION.md` "Composability rule".
 *
 * LEV-173 wired this for real: `AuthContext.getActiveOrm` returns the
 * active `ORMAdapter` (populated by the host from
 * `bootResult.adapters.getActive('orm')`). The better-auth impl uses this
 * to construct a Better Auth Prisma adapter that writes to the SAME tables
 * the rest of the app reads from — no separate sqlite file. Managed-identity
 * impls (Clerk, WorkOS) are free to ignore the field entirely.
 *
 * `databaseUrl` survives the transition for backwards-compat: existing
 * sqlite-mode tests still pass it directly and the better-auth impl uses
 * it as a NODE_ENV=test fallback when no ORM is active. Future tickets can
 * narrow this further once every caller plumbs `getActiveOrm`.
 */

import type { ORMAdapter } from '../orm/types';

export interface AuthContext {
  /**
   * Connection string for the auth impl's user/session store.
   *
   * NOTE: this field is a known composability leak (see LEV-122). It works
   * for DB-backed auth impls (BetterAuth, Lucia) but managed-identity impls
   * (Clerk, WorkOS) have no DB connection of their own — they would have
   * to ignore this field. LEV-173 made the better-auth impl prefer
   * `getActiveOrm` when available and only fall back to this URL under
   * NODE_ENV=test; the field stays for the fallback path until every
   * call site provides a real ORM.
   */
  databaseUrl: string;
  /** Shared signing secret used to mint/verify session references. */
  secret: string;
  /**
   * Returns the active `ORMAdapter` from the host's AdapterRegistry, or
   * `undefined` when no ORM plugin is loaded. Optional so synthetic
   * `AuthContext` literals in tests / out-of-tree callers continue to
   * typecheck without plumbing.
   *
   * Auth impls that need a database (BetterAuth, Lucia, …) should consult
   * this first and dispatch on `orm.name` to pick the right downstream
   * adapter shape (e.g. `@better-auth/prisma-adapter` vs
   * `@better-auth/drizzle-adapter`). Managed-identity impls (Clerk,
   * WorkOS) can ignore it.
   *
   * The host populates this from `bootResult.adapters.getActive('orm')`
   * — see `plugin-better-auth/src/index.ts` for the wiring.
   */
  getActiveOrm?: () => ORMAdapter | undefined;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
}

export interface SessionToken {
  /** Opaque session reference (JWT, opaque token id, signed cookie value, …). */
  token: string;
  /** ISO8601 timestamp when this session token expires. */
  expiresAt: string;
}

export interface SessionInfo {
  userId: string;
  expiresAt: string;
}

export interface AuthAdapter {
  name: string;
  createUser(ctx: AuthContext, input: CreateUserInput): Promise<User>;
  signSession(ctx: AuthContext, userId: string): Promise<SessionToken>;
  inspectSession(ctx: AuthContext, token: string): Promise<SessionInfo | null>;
  /**
   * Optional lookup-by-email. Returns `null` if the user does not exist.
   * Used by the orchestration layer (auth/helpers.ts) to make `getOrCreateUser`
   * and `loginAs` idempotent. Adapters that don't support lookup can omit it,
   * in which case the helpers will surface a clear error when a duplicate
   * email is encountered.
   */
  findUserByEmail?(ctx: AuthContext, email: string): Promise<User | null>;
}
