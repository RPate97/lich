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
 * TODO(LEV-122 / composability): `AuthContext.databaseUrl` exists because
 * the current better-auth impl needs a connection string. A fully
 * composability-correct impl would consume the active ORM via context
 * lookup and never see a raw URL. When LEV-122 lands, `AuthContext` should
 * shrink to `{ secret }` (or be replaced by a capability lookup entirely)
 * so that `Clerk`-style impls — which have no DB of their own — can honor
 * the contract without inventing a fake URL.
 */

export interface AuthContext {
  /**
   * Connection string for the auth impl's user/session store.
   *
   * NOTE: this field is a known composability leak (see LEV-122). It works
   * for DB-backed auth impls (BetterAuth, Lucia) but managed-identity impls
   * (Clerk, WorkOS) have no DB connection of their own — they would have
   * to ignore this field. Future work moves this lookup behind the active
   * ORM / capability registry.
   */
  databaseUrl: string;
  /** Shared signing secret used to mint/verify session references. */
  secret: string;
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
