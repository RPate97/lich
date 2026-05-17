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
}
