import { randomBytes } from 'node:crypto';
import type {
  AuthAdapter,
  AuthContext,
  SessionInfo,
  User,
} from '../adapters/auth/types';

export interface GetOrCreateUserArgs {
  adapter: AuthAdapter;
  ctx: AuthContext;
  email: string;
  /** Optional password. If omitted, an ephemeral random password is generated. */
  password?: string;
  /** Optional display name. Adapters that require one will fall back to email. */
  name?: string;
}

export interface LoginAsArgs {
  adapter: AuthAdapter;
  ctx: AuthContext;
  email: string;
}

export interface LoginAsResult {
  user: User;
  sessionToken: string;
  expiresAt: string;
}

export interface VerifyArgs {
  adapter: AuthAdapter;
  ctx: AuthContext;
  token: string;
}

export interface VerifyResult {
  userId: string;
}

/** Generate a random password suitable for ephemeral test users.
 *  Hex-encoded 16 bytes = 32 characters, well above any sane minimum. */
function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

/** Heuristic for "this createUser call failed because the email is taken". */
function isDuplicateEmailError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

/**
 * Idempotent create-or-fetch.
 *
 * - If the user already exists, returns the existing user.
 * - If not, creates one with `password` (or a generated random one).
 *
 * Requires the adapter to support `findUserByEmail` for the duplicate-recovery
 * path. Without it, a second call with the same email will throw a clear error
 * pointing at the missing capability.
 */
export async function getOrCreateUser(args: GetOrCreateUserArgs): Promise<User> {
  const { adapter, ctx, email, password, name } = args;
  // Fast path: if the adapter supports lookup, check first.
  if (adapter.findUserByEmail) {
    const existing = await adapter.findUserByEmail(ctx, email);
    if (existing) return existing;
  }
  try {
    return await adapter.createUser(ctx, {
      email,
      password: password ?? generatePassword(),
      name,
    });
  } catch (err) {
    if (!isDuplicateEmailError(err)) throw err;
    // Race: another caller (or a prior run) created the user between our
    // lookup and our create. Re-fetch if possible.
    if (adapter.findUserByEmail) {
      const existing = await adapter.findUserByEmail(ctx, email);
      if (existing) return existing;
    }
    throw new Error(
      `getOrCreateUser: user ${JSON.stringify(email)} already exists but adapter ` +
        `${JSON.stringify(adapter.name)} does not implement findUserByEmail; ` +
        `cannot satisfy idempotency contract.`,
    );
  }
}

/**
 * Mint a session token for the given email.
 *
 * For ephemeral test users, this creates the user on the fly if it doesn't
 * exist (with a random password — the caller never needs to know it). For
 * an existing user it simply signs a fresh session.
 */
export async function loginAs(args: LoginAsArgs): Promise<LoginAsResult> {
  const { adapter, ctx, email } = args;
  const user = await getOrCreateUser({ adapter, ctx, email });
  const session = await adapter.signSession(ctx, user.id);
  return {
    user,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
  };
}

/**
 * Verify a session token and return the userId it identifies.
 *
 * The underlying adapter's `inspectSession` throws on invalid/expired/tampered
 * tokens (or returns `null` for unknown ones). We translate either signal into
 * a thrown error so callers don't need to handle both shapes.
 */
export async function verifyAndExtractUserId(args: VerifyArgs): Promise<VerifyResult> {
  const { adapter, ctx, token } = args;
  let info: SessionInfo | null;
  try {
    info = await adapter.inspectSession(ctx, token);
  } catch (err) {
    throw err;
  }
  if (!info) {
    throw new Error('verifyAndExtractUserId: session is invalid (unknown)');
  }
  return { userId: info.userId };
}
