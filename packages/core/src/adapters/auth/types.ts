export interface AuthContext {
  databaseUrl: string;
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
